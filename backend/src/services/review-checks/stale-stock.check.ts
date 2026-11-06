import type { ReviewFlag } from "../../domain/models.js";
import { ageHours, linesForPart, type ReviewCheck, type ReviewContext } from "./review-check.js";

/**
 * Rule 10: a stock reading older than the policy limit (24h) may no longer be
 * true, so the specialist must confirm availability before the quote goes out.
 */
export class StaleStockCheck implements ReviewCheck {
  readonly name = "stale_stock";

  constructor(private readonly maxAgeHours: number) {}

  run({ draft, stock, now }: ReviewContext): ReviewFlag[] {
    if (!stock.ok) return [];
    return stock.items.flatMap((item) => {
      const age = ageHours(now, new Date(item.as_of));
      if (age <= this.maxAgeHours) return [];
      return linesForPart(draft, item.part_number).map((line) => ({
        line,
        reason: `stale stock reading: ${age}h old (as of ${item.as_of})`,
      }));
    });
  }
}
