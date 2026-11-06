import type { ReviewFlag } from "../../domain/models.js";
import type { ReviewCheck, ReviewContext } from "./review-check.js";

/**
 * Reliability rule: when the stock API is still failing after retries, the
 * quote is marked "stock unavailable" for the specialist instead of being
 * blocked (slows sales) or given guessed stock (misleads the customer).
 * Quote-level (`line: null`) because one failed batch covers every line.
 */
export class StockUnavailableCheck implements ReviewCheck {
  readonly name = "stock_unavailable";

  run({ stock }: ReviewContext): ReviewFlag[] {
    return stock.ok ? [] : [{ line: null, reason: "stock unavailable after retries" }];
  }
}
