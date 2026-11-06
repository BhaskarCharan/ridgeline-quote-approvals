import { ConfigurationError } from "../../domain/errors.js";
import type { Clock } from "../../ports/clock.js";

/**
 * A clock frozen at one instant (from APP_NOW, or set by a test). Lets the
 * sample drafts be processed "as of" the policy's reference time so results are
 * deterministic regardless of when the demo or the test suite runs.
 */
export class FixedClock implements Clock {
  private readonly instant: Date;

  constructor(instant: Date | string) {
    const parsed = typeof instant === "string" ? new Date(instant) : new Date(instant.getTime());
    if (Number.isNaN(parsed.getTime())) {
      throw new ConfigurationError("FixedClock needs a valid ISO 8601 instant", { instant: String(instant) });
    }
    this.instant = parsed;
  }

  /** Returns a copy so callers cannot mutate the frozen instant. */
  now(): Date {
    return new Date(this.instant.getTime());
  }
}
