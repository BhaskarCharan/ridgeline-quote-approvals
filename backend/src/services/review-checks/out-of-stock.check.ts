import type { ReviewFlag } from "../../domain/models.js";
import { linesForPart, type ReviewCheck, type ReviewContext } from "./review-check.js";

/**
 * Rule 9: a part with zero units in every warehouse needs a specialist to
 * decide between backorder, substitute or removal. We flag rather than drop
 * the line, because the customer may accept a backorder.
 */
export class OutOfStockEverywhereCheck implements ReviewCheck {
  readonly name = "out_of_stock_everywhere";

  run({ draft, stock }: ReviewContext): ReviewFlag[] {
    if (!stock.ok) return [];
    return stock.items
      .filter((item) => Object.values(item.warehouses).every((qty) => qty <= 0))
      .flatMap((item) =>
        linesForPart(draft, item.part_number).map((line) => ({ line, reason: "out of stock in all warehouses" })),
      );
  }
}
