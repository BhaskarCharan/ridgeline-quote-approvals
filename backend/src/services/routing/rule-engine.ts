import type { Decimal } from "decimal.js";
import { ConfigurationError } from "../../domain/errors.js";
import type { PolicyCondition, PolicyMetric, PolicyTier } from "../../domain/policy.js";

/** The quote-level numbers that tier conditions test. */
export type RoutingMetrics = Record<PolicyMetric, Decimal | null>;

/**
 * Evaluates the approval tiers from the policy YAML: the first tier whose
 * conditions match wins (rules ordered strictest first). There are no
 * thresholds in this code, so changing who approves what is a config change.
 *
 * Comparisons use unrounded Decimal values: 15.004% is "over 15%" even though
 * it displays as 15.00.
 */
export class RuleEngine {
  constructor(private readonly tiers: readonly PolicyTier[]) {}

  /** Return the first matching tier. The policy schema guarantees a catch-all. */
  evaluate(metrics: RoutingMetrics): PolicyTier {
    const tier = this.tiers.find((t) => t.always === true || (t.any ?? []).some((c) => matches(c, metrics)));
    if (!tier) {
      // Unreachable with a validated policy; kept so a bad policy can never route "nowhere".
      throw new ConfigurationError("No approval tier matched; the policy needs a catch-all tier");
    }
    return tier;
  }
}

/** A missing metric (e.g. no priced lines, so no discount) never satisfies a condition. */
function matches(condition: PolicyCondition, metrics: RoutingMetrics): boolean {
  const actual = metrics[condition.metric];
  if (actual === null) return false;
  switch (condition.op) {
    case "gt":
      return actual.greaterThan(condition.value);
    case "gte":
      return actual.greaterThanOrEqualTo(condition.value);
    case "lt":
      return actual.lessThan(condition.value);
    case "lte":
      return actual.lessThanOrEqualTo(condition.value);
  }
}
