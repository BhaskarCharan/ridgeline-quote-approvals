import { pino, type Logger } from "pino";
import { FixedClock } from "./adapters/clock/fixed-clock.js";
import { SystemClock } from "./adapters/clock/system-clock.js";
import { loadCsvReferenceData } from "./adapters/csv-reference-data.js";
import { DEFAULT_STOCK_CLIENT_OPTIONS, HttpStockClient } from "./adapters/http-stock-client.js";
import { MemoryAuditRepository } from "./adapters/memory/memory-audit-repository.js";
import { MemoryQuoteRepository } from "./adapters/memory/memory-quote-repository.js";
import { MongoAuditRepository } from "./adapters/mongo/mongo-audit-repository.js";
import { connectMongo } from "./adapters/mongo/mongo-connection.js";
import { MongoQuoteRepository } from "./adapters/mongo/mongo-quote-repository.js";
import { loadApprovalPolicy } from "./config/approval-policy.js";
import type { Env } from "./config/env.js";
import type { ApprovalPolicy } from "./domain/policy.js";
import type { Clock } from "./ports/clock.js";
import type { ReferenceData } from "./ports/reference-data.port.js";
import type { AuditRepository, QuoteRepository, ResettableStore } from "./ports/repositories.port.js";
import type { StockProvider } from "./ports/stock.port.js";
import { AuditService } from "./services/audit.service.js";
import { DuplicateDetector } from "./services/duplicate-detector.js";
import { PricingService } from "./services/pricing.service.js";
import { QuoteProcessor } from "./services/quote-processor.js";
import { QuoteReviewService } from "./services/review.service.js";
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
  quotes: QuoteRepository;
  audit: AuditService;
  processor: QuoteProcessor;
  review: QuoteReviewService;
  /** Wipe quotes and the audit log. Demo/test only; refused in production. */
  resetStores(): Promise<void>;
  /** Release external resources (Mongo connection). Idempotent. */
  close(): Promise<void>;
}

/** Repositories plus their lifecycle hooks, whichever backend was chosen. */
interface Stores {
  quotes: QuoteRepository & ResettableStore;
  audit: AuditRepository & ResettableStore;
  close(): Promise<void>;
}

/**
 * Wire the object graph by hand (constructor injection, no DI framework).
 * Async because the policy, the reference-data snapshot and the database are
 * loaded/connected up front: bad config should stop startup, not surface mid-quote.
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

  const stores = await createStores(env, logger);

  const timeZone = env.BUSINESS_TIMEZONE;
  const pricing = new PricingService(referenceData, clock, { timeZone });
  const audit = new AuditService(stores.audit, clock);

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
    quotes: stores.quotes,
    audit,
    policyVersion: policy.version,
  });

  const review = new QuoteReviewService(stores.quotes, audit, clock);

  let closed = false;
  return {
    env,
    logger,
    clock,
    policy,
    referenceData,
    pricing,
    stock,
    quotes: stores.quotes,
    audit,
    processor,
    review,
    resetStores: async () => {
      if (env.NODE_ENV === "production") {
        throw new Error("Refusing to reset quote and audit stores in production");
      }
      await Promise.all([stores.quotes.reset(), stores.audit.reset()]);
      logger.warn({ persistence: env.PERSISTENCE }, "Reset quotes and audit log (demo only)");
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await stores.close();
    },
  };
}

/** Pick the storage backend from PERSISTENCE. */
async function createStores(env: Env, logger: Logger): Promise<Stores> {
  if (env.PERSISTENCE === "memory") {
    logger.warn("Using in-memory persistence: quotes and audit are lost on exit");
    return { quotes: new MemoryQuoteRepository(), audit: new MemoryAuditRepository(), close: async () => {} };
  }

  const { client, db } = await connectMongo(env.MONGODB_URI, env.MONGODB_DB);
  const quotes = new MongoQuoteRepository(db);
  const audit = new MongoAuditRepository(db);
  await Promise.all([quotes.ensureIndexes(), audit.ensureIndexes()]);
  logger.info({ db: env.MONGODB_DB }, "Connected to MongoDB");
  return { quotes, audit, close: () => client.close() };
}
