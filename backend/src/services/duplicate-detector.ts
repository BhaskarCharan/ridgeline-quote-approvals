import type { DraftQuote } from "../domain/models.js";

/**
 * Rule 11: a draft with the same `rfq_id` and the same lines as a draft
 * received in the previous N hours is a duplicate (typically the extraction
 * service resubmitting after a timeout). Detecting it *before* pricing means
 * no second stock call and, crucially, no second approval request.
 *
 * "Same lines" compares part, quantity and unit as a multiset, ignoring line
 * numbers, order, descriptions and confidence scores, which can differ between
 * two extraction runs of the same RFQ.
 */
export class DuplicateDetector {
  private readonly windowMs: number;

  constructor(windowHours: number) {
    this.windowMs = windowHours * 3_600_000;
  }

  /**
   * The earliest earlier draft that `draft` duplicates, or undefined. Earliest,
   * so a chain of resubmissions all point at the one real original.
   */
  findOriginal(draft: DraftQuote, earlier: readonly DraftQuote[]): DraftQuote | undefined {
    const receivedAt = Date.parse(draft.created_at);
    const signature = lineSignature(draft);

    return earlier
      .filter((other) => {
        if (other.draft_id === draft.draft_id || other.rfq_id !== draft.rfq_id) return false;
        const age = receivedAt - Date.parse(other.created_at);
        return age >= 0 && age <= this.windowMs && lineSignature(other) === signature;
      })
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
  }
}

/** Order-independent fingerprint of a draft's lines. */
function lineSignature(draft: DraftQuote): string {
  return draft.lines
    .map((l) => `${l.part_number}|${l.quantity}|${l.unit}`)
    .sort()
    .join(";");
}
