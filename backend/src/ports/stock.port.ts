import type { StockReading } from "../domain/models.js";

/**
 * Outcome of a stock lookup, as a value rather than an exception.
 *
 * Why: the policy says a quote whose stock cannot be read is *marked* "stock
 * unavailable" for the specialist, never blocked and never guessed. Returning
 * a typed failure forces every caller to handle that branch explicitly.
 */
export type StockResult =
  | {
      ok: true;
      /** One reading per part found. Each carries its own `as_of` (may be stale). */
      items: StockReading[];
      /** Requested parts the stock system does not know (rule 9: specialist decides). */
      notFound: string[];
    }
  | {
      ok: false;
      /** Human-readable cause for logs and the audit trail (e.g. "HTTP 503 after 3 attempts"). */
      reason: string;
    };

/**
 * Read-only access to Ridgeline's hourly stock snapshot. Implementations own
 * batching, timeouts and retries, and must never throw: every failure comes
 * back as `{ ok: false }`.
 */
export interface StockProvider {
  /** Look up stock for the given parts. Duplicates are ignored; an empty list succeeds trivially. */
  getStock(partNumbers: readonly string[]): Promise<StockResult>;
}
