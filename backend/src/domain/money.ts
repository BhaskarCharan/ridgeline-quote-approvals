import { Decimal } from "decimal.js";

/**
 * Round to cents, half-up. Applied to each *line* total before summing, as the
 * project convention requires, so a quote total always equals the sum of the
 * line totals the reviewer sees (no hidden sub-cent drift).
 */
export function roundCents(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Sum a list of amounts; an empty list sums to zero. */
export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce((acc, v) => acc.plus(v), new Decimal(0));
}
