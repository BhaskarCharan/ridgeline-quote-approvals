import type { ReviewFlag } from "../../domain/models.js";
import { linesForPart, type ReviewCheck, type ReviewContext } from "./review-check.js";

/**
 * Rule 9: a part the stock API does not know cannot be promised to the
 * customer. Common cause: a replacement part (e.g. RL120374 replacing
 * discontinued RL150432) that exists in the catalogue but not yet in stock.
 */
export class NotInStockApiCheck implements ReviewCheck {
  readonly name = "not_in_stock_api";

  run({ draft, stock }: ReviewContext): ReviewFlag[] {
    if (!stock.ok) return [];
    return stock.notFound.flatMap((part) =>
      linesForPart(draft, part).map((line) => ({ line, reason: "part not found in stock API" })),
    );
  }
}
