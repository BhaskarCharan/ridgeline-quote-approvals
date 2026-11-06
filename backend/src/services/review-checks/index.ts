import type { PolicyThresholds } from "../../domain/policy.js";
import { LowConfidenceCheck } from "./low-confidence.check.js";
import { NotInStockApiCheck } from "./not-in-stock-api.check.js";
import { OutOfStockEverywhereCheck } from "./out-of-stock.check.js";
import type { ReviewCheck } from "./review-check.js";
import { StaleExportCheck } from "./stale-export.check.js";
import { StaleStockCheck } from "./stale-stock.check.js";
import { StockUnavailableCheck } from "./stock-unavailable.check.js";

export type { ReviewCheck, ReviewContext } from "./review-check.js";
export {
  LowConfidenceCheck,
  NotInStockApiCheck,
  OutOfStockEverywhereCheck,
  StaleExportCheck,
  StaleStockCheck,
  StockUnavailableCheck,
};

/**
 * The standard check set, with thresholds taken from the approval policy so
 * they change with the YAML, not with a release.
 */
export function createReviewChecks(thresholds: PolicyThresholds): ReviewCheck[] {
  return [
    new LowConfidenceCheck(thresholds.min_confidence),
    new OutOfStockEverywhereCheck(),
    new NotInStockApiCheck(),
    new StaleStockCheck(thresholds.max_stock_age_hours),
    new StockUnavailableCheck(),
    new StaleExportCheck(thresholds.max_export_age_hours),
  ];
}
