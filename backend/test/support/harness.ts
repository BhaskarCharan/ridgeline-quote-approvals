import { readFile } from "node:fs/promises";
import type { Express } from "express";
import { pino } from "pino";
import path from "node:path";
import { FixedClock } from "../../src/adapters/clock/fixed-clock.js";
import { createApp } from "../../src/api/app.js";
import { loadCsvReferenceData } from "../../src/adapters/csv-reference-data.js";
import { loadDraftsFromFile } from "../../src/adapters/json-draft-file.js";
import { MemoryAuditRepository } from "../../src/adapters/memory/memory-audit-repository.js";
import { MemoryQuoteRepository } from "../../src/adapters/memory/memory-quote-repository.js";
import { loadApprovalPolicy } from "../../src/config/approval-policy.js";
import { REPO_ROOT } from "../../src/config/env.js";
import type { DraftQuote, StockReading } from "../../src/domain/models.js";
import type { ApprovalPolicy } from "../../src/domain/policy.js";
import type { Clock } from "../../src/ports/clock.js";
import type { ReferenceData } from "../../src/ports/reference-data.port.js";
import type { StockProvider, StockResult } from "../../src/ports/stock.port.js";
import { AuditService } from "../../src/services/audit.service.js";
import { DuplicateDetector } from "../../src/services/duplicate-detector.js";
import { PricingService } from "../../src/services/pricing.service.js";
import { QuoteProcessor } from "../../src/services/quote-processor.js";
import { QuoteReviewService } from "../../src/services/review.service.js";
import { createReviewChecks } from "../../src/services/review-checks/index.js";
import { ApproverResolver } from "../../src/services/routing/approver-resolver.js";
import { RuleEngine } from "../../src/services/routing/rule-engine.js";

export const POLICY_NOW = "2026-10-12T09:30:00-05:00";
export const TIME_ZONE = "America/Chicago";
const DATA_PACK = path.join(REPO_ROOT, "data-pack_platform");

/** Stock provider backed by the data pack's stock_fixture.json; counts calls. */
export class FixtureStockProvider implements StockProvider {
  calls = 0;
  failing = false;

  constructor(private readonly fixture: Record<string, StockReading>) {}

  static async load(): Promise<FixtureStockProvider> {
    const raw = await readFile(path.join(DATA_PACK, "stock_fixture.json"), "utf8");
    return new FixtureStockProvider(JSON.parse(raw) as Record<string, StockReading>);
  }

  async getStock(partNumbers: readonly string[]): Promise<StockResult> {
    this.calls++;
    if (this.failing) return { ok: false, reason: "stock unavailable after 3 attempts (last error: HTTP 503)" };
    const unique = [...new Set(partNumbers)];
    return {
      ok: true,
      items: unique.flatMap((p) => (this.fixture[p] ? [this.fixture[p]] : [])),
      notFound: unique.filter((p) => !this.fixture[p]),
    };
  }
}

/** A fully wired processor over the real sample data, with in-memory stores. */
export interface Harness {
  processor: QuoteProcessor;
  review: QuoteReviewService;
  /** The real Express app wired to this harness. */
  app: Express;
  quotes: MemoryQuoteRepository;
  auditRepo: MemoryAuditRepository;
  audit: AuditService;
  stock: FixtureStockProvider;
  referenceData: ReferenceData;
  policy: ApprovalPolicy;
  clock: Clock;
  drafts: DraftQuote[];
  draft(id: string): DraftQuote;
}

export async function createHarness(options: { now?: string; referenceData?: ReferenceData } = {}): Promise<Harness> {
  const clock = new FixedClock(options.now ?? POLICY_NOW);
  const [policy, loadedRef, drafts, stock] = await Promise.all([
    loadApprovalPolicy(path.join(REPO_ROOT, "backend/config/approval-policy.yaml")),
    options.referenceData ? Promise.resolve(options.referenceData) : loadCsvReferenceData(path.join(DATA_PACK, "reporting_db")),
    loadDraftsFromFile(path.join(DATA_PACK, "draft_quotes.json")),
    FixtureStockProvider.load(),
  ]);
  const referenceData = loadedRef;
  const quotes = new MemoryQuoteRepository();
  const auditRepo = new MemoryAuditRepository();
  const audit = new AuditService(auditRepo, clock);

  const processor = new QuoteProcessor({
    pricing: new PricingService(referenceData, clock, { timeZone: TIME_ZONE }),
    stock,
    checks: createReviewChecks(policy.thresholds),
    ruleEngine: new RuleEngine(policy.tiers),
    approverResolver: new ApproverResolver(referenceData, clock, { timeZone: TIME_ZONE }),
    duplicates: new DuplicateDetector(policy.thresholds.duplicate_window_hours),
    referenceData,
    clock,
    quotes,
    audit,
    policyVersion: policy.version,
  });

  const review = new QuoteReviewService(quotes, audit, clock);
  const app = createApp({
    clock,
    logger: pino({ level: "silent" }),
    corsOrigin: "http://localhost:4200",
    referenceData,
    review,
    processor,
  });

  return {
    processor,
    review,
    app,
    quotes,
    auditRepo,
    audit,
    stock,
    referenceData,
    policy,
    clock,
    drafts,
    draft: (id) => {
      const d = drafts.find((x) => x.draft_id === id);
      if (!d) throw new Error(`no draft ${id}`);
      return structuredClone(d);
    },
  };
}
