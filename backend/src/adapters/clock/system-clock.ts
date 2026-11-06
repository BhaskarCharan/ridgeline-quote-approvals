import type { Clock } from "../../ports/clock.js";

/**
 * Real wall-clock time. Used in production, where APP_NOW is unset. This is the
 * only place in the backend allowed to read the system time.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
