import type { ReviewFlag } from "../../domain/models.js";
import type { ReviewCheck, ReviewContext } from "./review-check.js";

/**
 * Rule 8: a line the extraction model was unsure about (confidence below the
 * policy minimum) must be checked by a specialist, because the part or quantity
 * may simply be wrong. Strictly "below": a line exactly at the minimum passes.
 */
export class LowConfidenceCheck implements ReviewCheck {
  readonly name = "low_confidence";

  constructor(private readonly minConfidence: number) {}

  run({ draft }: ReviewContext): ReviewFlag[] {
    return draft.lines
      .filter((l) => l.extraction_confidence < this.minConfidence)
      .map((l) => ({ line: l.line, reason: `extraction confidence ${l.extraction_confidence.toFixed(2)}` }));
  }
}
