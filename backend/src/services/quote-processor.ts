import { RoutingOutcome } from "../domain/enums.js";
import type { DraftQuote, QuotePricing, ReviewFlag } from "../domain/models.js";
import type { Clock } from "../ports/clock.js";
import type { ReferenceData } from "../ports/reference-data.port.js";
import type { StockProvider, StockResult } from "../ports/stock.port.js";
import type { DuplicateDetector } from "./duplicate-detector.js";
import type { PricingService } from "./pricing.service.js";
import type { ReviewCheck, ReviewContext } from "./review-checks/index.js";
import type { ApproverResolution, ApproverResolver } from "./routing/approver-resolver.js";
import type { RuleEngine } from "./routing/rule-engine.js";

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
   * Process drafts in order. Each draft is checked for duplicates against the
   * drafts before it, so a resubmission later in the batch points at the original.
   */
  async processBatch(drafts: readonly DraftQuote[]): Promise<ProcessedDraft[]> {
    const results: ProcessedDraft[] = [];
    for (const draft of drafts) {
      results.push(await this.process(draft, results.map((r) => r.draft)));
    }
    return results;
  }

  /** Process one draft. `earlier` are drafts already received (for rule 11). */
  async process(draft: DraftQuote, earlier: readonly DraftQuote[]): Promise<ProcessedDraft> {
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
