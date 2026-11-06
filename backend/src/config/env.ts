import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isValidTimeZone } from "../domain/dates.js";
import { ConfigurationError } from "../domain/errors.js";

/**
 * Repo root (`fsl_certificate/`), derived from this file's location rather than
 * `process.cwd()`, so default paths work whether the service is started from
 * the repo root, from `backend/`, or by the test runner.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Default reference time from `approval_rules.md`: Mon 2026-10-12 09:30 Central (CDT). */
const POLICY_REFERENCE_TIME = "2026-10-12T09:30:00-05:00";

const fromRepoRoot = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

const isoInstant = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be an ISO 8601 instant, e.g. 2026-10-12T09:30:00-05:00" });

/**
 * Every environment variable the backend reads, validated once at startup.
 * Defaults target local development so `npm run dev` / `npm run process` work
 * with no `.env`; production must set values explicitly (see `.env.example`).
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    CORS_ORIGIN: z.string().default("http://localhost:4200"),

    MONGODB_URI: z.string().url().default("mongodb://127.0.0.1:27017"),
    MONGODB_DB: z.string().min(1).default("ridgeline_quotes"),

    /** Freeze "now" (FixedClock). Unset in production -> SystemClock. */
    APP_NOW: isoInstant.optional(),

    STOCK_API_BASE_URL: z.string().url().default("http://localhost:8080"),
    /** Per-attempt timeout (covers connect + body). */
    STOCK_API_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
    /** Total attempts per batch call, including the first (3 = 1 call + 2 retries). */
    STOCK_API_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    STOCK_API_BACKOFF_BASE_MS: z.coerce.number().int().min(0).default(200),
    /** Upper bound on an upstream `retry_after_seconds` hint, so one hint cannot stall a quote. */
    STOCK_API_MAX_RETRY_AFTER_MS: z.coerce.number().int().min(0).default(5000),

    /** Ridgeline's business time zone: decides "today" for contract and out-of-office dates. */
    BUSINESS_TIMEZONE: z
      .string()
      .default("America/Chicago")
      .refine(isValidTimeZone, { message: "must be an IANA time zone, e.g. America/Chicago" }),

    DATA_PACK_DIR: z.string().default("data-pack_platform"),
    /** Read-only nightly reporting export (CSVs + export_metadata.json). */
    REPORTING_DB_DIR: z.string().default("data-pack_platform/reporting_db"),
    APPROVAL_POLICY_PATH: z.string().default("backend/config/approval-policy.yaml"),
    ROUTING_RESULTS_PATH: z.string().default("outputs/routing_results.json"),
  })
  .transform((e) => ({
    ...e,
    // Outside production, default to the policy's reference time so local runs
    // reproduce the expected routing. Production never gets a frozen clock by accident.
    APP_NOW: e.APP_NOW ?? (e.NODE_ENV === "production" ? undefined : POLICY_REFERENCE_TIME),
    DATA_PACK_DIR: fromRepoRoot(e.DATA_PACK_DIR),
    REPORTING_DB_DIR: fromRepoRoot(e.REPORTING_DB_DIR),
    APPROVAL_POLICY_PATH: fromRepoRoot(e.APPROVAL_POLICY_PATH),
    ROUTING_RESULTS_PATH: fromRepoRoot(e.ROUTING_RESULTS_PATH),
  }));

/** Validated, typed configuration. Paths are absolute. */
export type Env = z.infer<typeof EnvSchema>;

/**
 * Parse and validate configuration. Throws a ConfigurationError listing every
 * bad variable (names only, never values, so secrets cannot leak into logs).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ variable: i.path.join("."), problem: i.message }));
    throw new ConfigurationError("Invalid environment configuration", { issues });
  }
  return result.data;
}
