import type { DraftQuote, ReviewFlag } from "../../domain/models.js";
import type { StockResult } from "../../ports/stock.port.js";

/** Everything a check may look at. Built once per draft by the QuoteProcessor. */
export interface ReviewContext {
  draft: DraftQuote;
  stock: StockResult;
  /** "Now" from the injected Clock, captured once so every check agrees. */
  now: Date;
  /** When the reporting export was produced. */
  exportedAt: Date;
}

/**
 * One rule that can send a quote to a specialist before routing
 * (approval_rules.md rules 8-10). One class per rule keeps each testable on its
 * own, and adding a rule means adding a class, not editing a long if-chain.
 *
 * Checks only *flag*; they never block or reprice. A person decides.
 */
export interface ReviewCheck {
  /** Stable identifier for logs and audit. */
  readonly name: string;
  run(context: ReviewContext): ReviewFlag[];
}

/** Draft line numbers that reference `partNumber` (a part may appear on several lines). */
export function linesForPart(draft: DraftQuote, partNumber: string): number[] {
  return draft.lines.filter((l) => l.part_number === partNumber).map((l) => l.line);
}

/** Age in hours, rounded to one decimal for display. */
export function ageHours(now: Date, then: Date): number {
  return Math.round(((now.getTime() - then.getTime()) / 3_600_000) * 10) / 10;
}
