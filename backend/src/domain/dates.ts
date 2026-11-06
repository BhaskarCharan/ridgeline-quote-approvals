/**
 * The calendar date (YYYY-MM-DD) of an instant in a given IANA time zone.
 *
 * Why: contract validity and out-of-office ranges are plain dates in Ridgeline's
 * business time zone (Central). Using UTC would flip the date for anything
 * after 19:00 Central and silently apply or drop a contract price.
 */
export function calendarDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** True if `timeZone` is an IANA zone the runtime understands. Used to fail fast on bad config. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
