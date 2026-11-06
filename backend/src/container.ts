import { pino, type Logger } from "pino";
import { FixedClock } from "./adapters/clock/fixed-clock.js";
import { SystemClock } from "./adapters/clock/system-clock.js";
import { loadCsvReferenceData } from "./adapters/csv-reference-data.js";
import { DEFAULT_STOCK_CLIENT_OPTIONS, HttpStockClient } from "./adapters/http-stock-client.js";
import { loadApprovalPolicy } from "./config/approval-policy.js";
import type { Env } from "./config/env.js";
import type { ApprovalPolicy } from "./domain/policy.js";
import type { Clock } from "./ports/clock.js";
import type { ReferenceData } from "./ports/reference-data.port.js";
import type { StockProvider } from "./ports/stock.port.js";
import { DuplicateDetector } from "./services/duplicate-detector.js";
import { PricingService } from "./services/pricing.service.js";
import { QuoteProcessor } from "./services/quote-processor.js";
import { createReviewChecks } from "./services/review-checks/index.js";
import { ApproverResolver } from "./services/routing/approver-resolver.js";
import { RuleEngine } from "./services/routing/rule-engine.js";

/**
 * Everything the entry points (server, CLI) need, fully wired. This is the only
 * module that knows which adapter implements which port, which is what keeps
 * services testable with fakes and swappable for production adapters.
 */
export interface Container {
  env: Env;
  logger: Logger;
  clock: Clock;
  policy: ApprovalPolicy;
  referenceData: ReferenceData;
  pricing: PricingService;
  stock: StockProvider;
  processor: QuoteProcessor;
  /** Release external resources (Mongo connections, etc.). Idempotent. */
  close(): Promise<void>;
}

/**
 * Wire the object graph by hand (constructor injection, no DI framework).
 * Async because the policy and the reference-data snapshot are loaded and
 * validated up front: bad config should stop startup, not surface mid-quote.
 */
export async function createContainer(env: Env): Promise<Container> {
  const logger = pino({ level: env.LOG_LEVEL });
  const clock: Clock = env.APP_NOW ? new FixedClock(env.APP_NOW) : new SystemClock();
  if (env.APP_NOW) logger.info({ appNow: env.APP_NOW }, "Using fixed clock");

  const [policy, referenceData] = await Promise.all([
    loadApprovalPolicy(env.APPROVAL_POLICY_PATH),
    loadCsvReferenceData(env.REPORTING_DB_DIR),
  ]);
  logger.info({ file: env.APPROVAL_POLICY_PATH, version: policy.version }, "Loaded approval policy");
  logger.info(
    { dir: env.REPORTING_DB_DIR, exportedAt: referenceData.exportedAt.toISOString() },
    "Loaded reporting data snapshot",
  );

  const timeZone = env.BUSINESS_TIMEZONE;
  const pricing = new PricingService(referenceData, clock, { timeZone });

  const stock = new HttpStockClient(
    {
      ...DEFAULT_STOCK_CLIENT_OPTIONS,
      baseUrl: env.STOCK_API_BASE_URL,
      timeoutMs: env.STOCK_API_TIMEOUT_MS,
      maxAttempts: env.STOCK_API_MAX_ATTEMPTS,
      backoffBaseMs: env.STOCK_API_BACKOFF_BASE_MS,
      maxRetryAfterMs: env.STOCK_API_MAX_RETRY_AFTER_MS,
    },
    { logger },
  );

  const processor = new QuoteProcessor({
    pricing,
    stock,
    checks: createReviewChecks(policy.thresholds),
    ruleEngine: new RuleEngine(policy.tiers),
    approverResolver: new ApproverResolver(referenceData, clock, { timeZone }),
    duplicates: new DuplicateDetector(policy.thresholds.duplicate_window_hours),
    referenceData,
    clock,
  });

  return {
    env,
    logger,
    clock,
    policy,
    referenceData,
    pricing,
    stock,
    processor,
    close: async () => {},
  };
}
