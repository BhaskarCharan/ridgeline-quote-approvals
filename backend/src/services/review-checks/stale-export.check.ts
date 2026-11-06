import type { ReviewFlag } from "../../domain/models.js";
import { ageHours, type ReviewCheck, type ReviewContext } from "./review-check.js";

/**
 * Rule 10: if the nightly reporting export is older than the policy limit
 * (36h, i.e. at least one nightly run was missed), prices and contracts may be
 * out of date, so the specialist must confirm them. Quote-level flag.
 */
export class StaleExportCheck implements ReviewCheck {
  readonly name = "stale_export";

  constructor(private readonly maxAgeHours: number) {}

  run({ now, exportedAt }: ReviewContext): ReviewFlag[] {
    const age = ageHours(now, exportedAt);
    if (age <= this.maxAgeHours) return [];
    return [{ line: null, reason: `reporting data is ${age}h old (exported ${exportedAt.toISOString()})` }];
  }
}
