import { AuditAction, QuoteStatus, RoutingOutcome } from "../domain/enums.js";
import type { DraftQuote, Quote, QuoteLine, QuotePricing, ReviewFlag } from "../domain/models.js";
import type { Clock } from "../ports/clock.js";
import type { ReferenceData } from "../ports/reference-data.port.js";
import type { QuoteRepository } from "../ports/repositories.port.js";
import type { StockProvider, StockResult } from "../ports/stock.port.js";
import type { AuditService } from "./audit.service.js";
import type { DuplicateDetector } from "./duplicate-detector.js";
import type { PricingService } from "./pricing.service.js";
import type { ReviewCheck, ReviewContext } from "./review-checks/index.js";
import type { ApproverResolution, ApproverResolver } from "./routing/approver-resolver.js";
import type { RuleEngine } from "./routing/rule-engine.js";
import { toRoutingResult } from "./routing-result.mapper.js";

/** The actor recorded for automated pipeline steps. */
export const SYSTEM_ACTOR = "system";

/** Everything decided about one draft, with the evidence behind each decision. */
export interface ProcessedDraft {
  draft: DraftQuote;
  outcome: RoutingOutcome;
  duplicate_of: string | null;
  /** Null for duplicates: they are not priced or stock-checked again. */
  pricing: QuotePricing | null;
  stock: StockResult | null;
  /** Name of the policy tier that matched; null for duplicates. */
  tier: string | null;
  /** Approver after backups; null when specialist-only or duplicate. */
  approver: ApproverResolution | null;
  /** Sorted by line, quote-level (`line: null`) flags last; de-duplicated. */
  specialist_review_flags: ReviewFlag[];
  processed_at: string;
}

/** Collaborators for {@link QuoteProcessor}. All are ports or services; no adapters. */
export interface QuoteProcessorDeps {
  pricing: PricingService;
  stock: StockProvider;
  checks: readonly ReviewCheck[];
  ruleEngine: RuleEngine;
  approverResolver: ApproverResolver;
  duplicates: DuplicateDetector;
  referenceData: ReferenceData;
  clock: Clock;
  quotes: QuoteRepository;
  audit: AuditService;
  /** Stored on each quote so a past routing can be explained after the policy changes. */
  policyVersion: string;
}

/** Outcome of processing one draft. */
export interface ProcessResult {
  /** The stored quote (new, or the one already stored for this draftId). */
  quote: Quote;
  /** False when the draftId had already been processed: nothing was recomputed or written. */
  created: boolean;
}

/**
 * The pipeline for one draft: duplicate check -> pricing -> stock -> review
 * checks -> tier -> approver (with backups).
 *
 * Nothing here sends a quote anywhere. The output is always "a person must act
 * next": a specialist on every quote, plus an approver when the tier needs one.
 * Problems with data (stale, missing, unavailable) become flags for that
 * person, never exceptions that would lose the quote.
 */
export class QuoteProcessor {
  constructor(private readonly deps: QuoteProcessorDeps) {}

  /**
   * Process drafts in order. Each one is saved before the next starts, so a
   * resubmission later in the batch finds its original in the repository.
   */
  async processBatch(drafts: readonly DraftQuote[]): Promise<ProcessResult[]> {
    const results: ProcessResult[] = [];
    for (const draft of drafts) results.push(await this.process(draft));
    return results;
  }

  /**
   * Process and persist one draft. Idempotent per draftId: a draft that was
   * already processed is returned as stored, with no new stock call, no new
   * approval request and no new audit entry. Re-sending a *changed* draft under
   * the same id is also a no-op; changes go through an explicit edit instead.
   */
  async process(draft: DraftQuote): Promise<ProcessResult> {
    const { quotes, audit } = this.deps;

    const existing = await quotes.findById(draft.draft_id);
    if (existing) return { quote: existing, created: false };

    // Duplicates are found among *stored* quotes, so they are caught across
    // CLI runs and API calls, not only within one batch.
    const earlier = (await quotes.findByRfqId(draft.rfq_id)).map((q) => q.draft);
    const decided = await this.decide(draft, earlier);

    const result = await quotes.insertIfAbsent(this.toQuote(decided));
    if (result.created) {
      // No transactions on a standalone Mongo: the quote is written first, so a
      // crash here loses at most this audit line, never the quote itself.
      const { quote } = result;
      await audit.record({
        actor: SYSTEM_ACTOR,
        action: AuditAction.QuoteCreated,
        quoteId: quote.draftId,
        statusBefore: null,
        statusAfter: quote.status,
        changes: {
          status: { before: null, after: quote.status },
          approverId: { before: null, after: quote.routing.approver_id },
          netTotal: { before: null, after: quote.netTotal },
          duplicateOf: { before: null, after: quote.routing.duplicate_of },
        },
      });
    }
    return result;
  }

  /** The pure decision for one draft: no writes. */
  private async decide(draft: DraftQuote, earlier: readonly DraftQuote[]): Promise<ProcessedDraft> {
    const { pricing, stock, checks, ruleEngine, approverResolver, duplicates, referenceData, clock } = this.deps;
    const now = clock.now();

    const original = duplicates.findOriginal(draft, earlier);
    if (original) {
      return {
        draft,
        outcome: RoutingOutcome.Duplicate,
        duplicate_of: original.draft_id,
        pricing: null,
        stock: null,
        tier: null,
        approver: null,
        specialist_review_flags: [],
        processed_at: now.toISOString(),
      };
    }

    const priced = pricing.price(draft);
    const stockResult = await stock.getStock(draft.lines.map((l) => l.part_number));

    const context: ReviewContext = { draft, stock: stockResult, now, exportedAt: referenceData.exportedAt };
    const flags: ReviewFlag[] = [...priced.specialist_review_flags, ...checks.flatMap((c) => c.run(context))];

    const tier = ruleEngine.evaluate({
      effective_discount_pct: priced.effective_discount_pct,
      net_total: priced.net_total,
    });

    let approver: ApproverResolution | null = null;
    if (tier.approver_role !== null) {
      const region = referenceData.getCustomer(draft.customer_id)?.region ?? null;
      approver = approverResolver.resolve(tier.approver_role, region, tier.match_customer_region);
      if (!approver.ok) {
        // Still approver_required: the specialist must find an approver by hand.
        flags.push({ line: null, reason: `no available ${tier.approver_role}: ${approver.reason}` });
      }
    }

    return {
      draft,
      outcome: tier.approver_role === null ? RoutingOutcome.SpecialistOnly : RoutingOutcome.ApproverRequired,
      duplicate_of: null,
      pricing: priced,
      stock: stockResult,
      tier: tier.name,
      approver,
      specialist_review_flags: normaliseFlags(flags),
      processed_at: now.toISOString(),
    };
  }

  /**
   * Build the stored quote. Every non-duplicate starts at pending_specialist:
   * a specialist signs off on every quote, whatever the tier.
   */
  private toQuote(decided: ProcessedDraft): Quote {
    const { draft, pricing } = decided;
    const routing = toRoutingResult(decided);
    return {
      draftId: draft.draft_id,
      rfqId: draft.rfq_id,
      customerId: draft.customer_id,
      preparedBy: draft.prepared_by,
      receivedAt: draft.created_at,
      status: decided.outcome === RoutingOutcome.Duplicate ? QuoteStatus.Duplicate : QuoteStatus.PendingSpecialist,
      routing,
      tier: decided.tier,
      approverPath: decided.approver?.path ?? [],
      lines: toQuoteLines(draft, pricing),
      listTotal: pricing ? pricing.list_total.toFixed(2) : null,
      netTotal: pricing ? pricing.net_total.toFixed(2) : null,
      draft,
      decisions: [],
      policyVersion: this.deps.policyVersion,
      version: 1,
      createdAt: decided.processed_at,
      updatedAt: decided.processed_at,
    };
  }
}

/** Merge draft lines with their pricing; money as 2-dp strings. */
function toQuoteLines(draft: DraftQuote, pricing: QuotePricing | null): QuoteLine[] {
  return draft.lines.map((l) => {
    const priced = pricing?.lines.find((p) => p.line === l.line);
    const isPriced = priced?.kind === "priced";
    return {
      line: l.line,
      partNumber: l.part_number,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      extractionConfidence: l.extraction_confidence,
      priceSource: isPriced ? priced.price_source : null,
      listUnitPrice: isPriced ? priced.list_unit_price.toFixed(2) : null,
      baseUnitPrice: isPriced ? priced.base_unit_price.toFixed(2) : null,
      netTotal: isPriced ? priced.net_total.toFixed(2) : null,
    };
  });
}

/** Stable order (line ascending, quote-level last) and no repeated flags. */
function normaliseFlags(flags: readonly ReviewFlag[]): ReviewFlag[] {
  const seen = new Set<string>();
  const unique = flags.filter((f) => {
    const key = `${f.line ?? ""}\u0000${f.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Array.prototype.sort is stable, so flags on the same line keep pipeline order.
  return unique.sort((a, b) => (a.line ?? Number.POSITIVE_INFINITY) - (b.line ?? Number.POSITIVE_INFINITY));
}
