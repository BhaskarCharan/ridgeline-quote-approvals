import type { Logger } from "pino";
import { z } from "zod";
import type { StockReading } from "../domain/models.js";
import type { StockProvider, StockResult } from "../ports/stock.port.js";

/** Tunables for {@link HttpStockClient}; wired from env in container.ts. */
export interface HttpStockClientOptions {
  baseUrl: string;
  /** Per-attempt timeout, enforced with AbortSignal.timeout. */
  timeoutMs: number;
  /** Total attempts per batch, including the first. */
  maxAttempts: number;
  /** First backoff step; doubles each retry. */
  backoffBaseMs: number;
  /** Cap applied to the upstream `retry_after_seconds` hint. */
  maxRetryAfterMs: number;
  /** The API accepts at most 50 part numbers per call. */
  batchSize: number;
}

/** Defaults matching the stock API spec and the reliability requirements. */
export const DEFAULT_STOCK_CLIENT_OPTIONS: Omit<HttpStockClientOptions, "baseUrl"> = {
  timeoutMs: 2000,
  maxAttempts: 3,
  backoffBaseMs: 200,
  maxRetryAfterMs: 5000,
  batchSize: 50,
};

/**
 * Side-effecting collaborators, injectable so tests can run the full retry
 * logic instantly and deterministically (fake fetch, no real sleeping, fixed jitter).
 */
export interface HttpStockClientDeps {
  logger: Logger;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Returns [0, 1); used for jitter. */
  random?: () => number;
}

const StockReadingSchema = z.object({
  part_number: z.string().min(1),
  warehouses: z.record(z.string(), z.number().int().nonnegative()),
  as_of: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 instant"),
});

const BatchResponseSchema = z.object({
  items: z.array(StockReadingSchema),
  not_found: z.array(z.string()),
});
type BatchResponse = z.infer<typeof BatchResponseSchema>;

const RetryHintSchema = z.object({ retry_after_seconds: z.number().nonnegative() });

/** What one HTTP attempt produced, before the retry loop decides what to do. */
type AttemptOutcome =
  | { kind: "success"; body: BatchResponse }
  | { kind: "retryable"; cause: string; retryAfterMs: number | null }
  | { kind: "fatal"; cause: string };

/**
 * HTTP client for the read-only stock API (`GET /v1/stock?part_numbers=...`).
 *
 * Reliability rules, and why:
 * - Batch endpoint, max 50 parts per call: one round-trip per quote instead of
 *   one per line, which matters with an upstream that fails ~10% of requests.
 * - Retry only what can succeed on retry: 503, timeouts and network errors.
 *   400/404 and malformed bodies are deterministic, so retrying them only
 *   delays the quote.
 * - Exponential backoff with jitter, so many quotes retrying at once do not
 *   hit a recovering API in lockstep. An upstream `retry_after_seconds` hint
 *   is honoured but capped, so one hint cannot stall a quote indefinitely.
 * - Never throws. Exhausted retries return `{ ok: false }`, and the quote is
 *   marked "stock unavailable" rather than blocked or guessed.
 */
export class HttpStockClient implements StockProvider {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: Logger;

  constructor(
    private readonly options: HttpStockClientOptions,
    deps: HttpStockClientDeps,
  ) {
    this.logger = deps.logger.child({ component: "stock-api" });
    this.fetchFn = deps.fetch ?? globalThis.fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
  }

  async getStock(partNumbers: readonly string[]): Promise<StockResult> {
    try {
      const unique = [...new Set(partNumbers)];
      const items: StockReading[] = [];
      const notFound: string[] = [];

      // Sequential on purpose: a typical quote fits in one batch, and serial
      // calls are gentler on an upstream that is already shedding load.
      for (const batch of chunk(unique, this.options.batchSize)) {
        const result = await this.fetchBatch(batch);
        if (!result.ok) return result;
        items.push(...result.items);
        notFound.push(...result.notFound);
      }
      return { ok: true, items, notFound };
    } catch (err: unknown) {
      // Defensive: nothing above should throw, but the port promises it never does.
      this.logger.error({ err }, "Unexpected error in stock client");
      return { ok: false, reason: `unexpected stock client error: ${describe(err)}` };
    }
  }

  /** One batch with the retry loop around it. */
  private async fetchBatch(partNumbers: string[]): Promise<StockResult> {
    const { maxAttempts } = this.options;

    for (let attempt = 1; ; attempt++) {
      const outcome = await this.attempt(partNumbers);

      if (outcome.kind === "success") {
        return { ok: true, items: outcome.body.items, notFound: outcome.body.not_found };
      }
      if (outcome.kind === "fatal") {
        this.logger.error({ attempt, cause: outcome.cause, parts: partNumbers.length }, "Stock API call failed (not retryable)");
        return { ok: false, reason: `stock API error: ${outcome.cause}` };
      }
      if (attempt >= maxAttempts) {
        this.logger.error({ attempt, maxAttempts, cause: outcome.cause, parts: partNumbers.length }, "Stock API retries exhausted");
        return { ok: false, reason: `stock unavailable after ${maxAttempts} attempts (last error: ${outcome.cause})` };
      }

      const delayMs = this.retryDelay(attempt, outcome.retryAfterMs);
      this.logger.warn(
        { attempt, maxAttempts, delayMs, cause: outcome.cause, retryAfterMs: outcome.retryAfterMs, parts: partNumbers.length },
        "Stock API call failed; retrying",
      );
      await this.sleep(delayMs);
    }
  }

  /** A single HTTP request, classified as success / retryable / fatal. Never throws. */
  private async attempt(partNumbers: string[]): Promise<AttemptOutcome> {
    // Relative path + trailing slash keeps any prefix in the base URL (e.g. behind a gateway).
    const base = this.options.baseUrl.endsWith("/") ? this.options.baseUrl : `${this.options.baseUrl}/`;
    const url = new URL("v1/stock", base);
    url.searchParams.set("part_numbers", partNumbers.join(","));

    try {
      const res = await this.fetchFn(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });

      if (res.status === 503) {
        return { kind: "retryable", cause: "HTTP 503", retryAfterMs: await readRetryHint(res) };
      }
      if (!res.ok) {
        return { kind: "fatal", cause: `HTTP ${res.status}` };
      }

      // The body read is still covered by the timeout signal.
      const parsed = BatchResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        return { kind: "fatal", cause: `malformed response: ${parsed.error.issues[0]?.message ?? "invalid body"}` };
      }
      return { kind: "success", body: parsed.data };
    } catch (err: unknown) {
      if (isTimeout(err)) {
        return { kind: "retryable", cause: `timeout after ${this.options.timeoutMs} ms`, retryAfterMs: null };
      }
      if (err instanceof TypeError) {
        // undici reports connection refused / reset / DNS failures as TypeError("fetch failed").
        return { kind: "retryable", cause: `network error: ${describe(err)}`, retryAfterMs: null };
      }
      if (err instanceof SyntaxError) {
        return { kind: "fatal", cause: "response was not valid JSON" };
      }
      return { kind: "fatal", cause: describe(err) };
    }
  }

  /**
   * Exponential backoff with "equal jitter": half the step is fixed, half is
   * random, so retries never collapse to zero yet still spread out. An upstream
   * hint raises the wait to at least the (capped) hinted value.
   */
  private retryDelay(attempt: number, retryAfterMs: number | null): number {
    const step = this.options.backoffBaseMs * 2 ** (attempt - 1);
    const backoff = step / 2 + this.random() * (step / 2);
    const hinted = retryAfterMs === null ? 0 : Math.min(retryAfterMs, this.options.maxRetryAfterMs);
    return Math.round(Math.max(backoff, hinted));
  }
}

/** Read `retry_after_seconds` from a 503 body (or a Retry-After header). Null if absent or unparsable. */
async function readRetryHint(res: Response): Promise<number | null> {
  try {
    const parsed = RetryHintSchema.safeParse(await res.json());
    if (parsed.success) return parsed.data.retry_after_seconds * 1000;
  } catch {
    // Not JSON; fall through to the header.
  }
  const header = res.headers.get("retry-after");
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/** AbortSignal.timeout rejects with a DOMException named "TimeoutError". */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * One-line error description for logs and flags. Node's fetch wraps socket
 * failures as TypeError("fetch failed") whose cause may be an AggregateError
 * with an empty message, so fall back to the cause's `code` (e.g. ECONNREFUSED).
 */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (!(cause instanceof Error)) return err.message;
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  const detail = cause.message || code || cause.name;
  return `${err.message} (${detail})`;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
