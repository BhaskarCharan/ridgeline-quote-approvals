/**
 * Source of "now" for every time-dependent rule: contract validity, out-of-office
 * dates, stale stock (24h), stale reporting export (36h), the duplicate window.
 *
 * Why a port: the policy says to process the sample drafts *as of* Monday
 * 2026-10-12 09:30 Central. Injecting the clock makes that reproducible in the
 * CLI and in tests, and keeps services free of `new Date()` / `Date.now()`.
 */
export interface Clock {
  /** The current instant. */
  now(): Date;
}
