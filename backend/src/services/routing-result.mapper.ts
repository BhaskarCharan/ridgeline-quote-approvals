import { Decimal } from "decimal.js";
import type { RoutingResult } from "../domain/models.js";
import type { ProcessedDraft } from "./quote-processor.js";

/**
 * Convert a processed draft to the exact shape of TASK.md Deliverable 1
 * (`outputs/routing_results.json`). This is the only place Decimal values
 * become JSON numbers, rounded half-up to 2 dp; everything upstream keeps full
 * precision so routing never depends on display rounding.
 */
export function toRoutingResult(processed: ProcessedDraft): RoutingResult {
  const { pricing, approver } = processed;
  return {
    draft_id: processed.draft.draft_id,
    status: processed.outcome,
    net_total: pricing ? to2dp(pricing.net_total) : null,
    effective_discount_pct: pricing?.effective_discount_pct ? to2dp(pricing.effective_discount_pct) : null,
    approver_id: approver?.ok ? approver.approverId : null,
    specialist_review_flags: processed.specialist_review_flags.map(({ line, reason }) => ({ line, reason })),
    duplicate_of: processed.duplicate_of,
  };
}

function to2dp(value: Decimal): number {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
}
