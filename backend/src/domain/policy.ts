import { Decimal } from "decimal.js";
import { z } from "zod";
import { ROLES, Role } from "./enums.js";

/**
 * Schema for `backend/config/approval-policy.yaml`. The policy is data, not
 * code, so Ridgeline can change thresholds or tiers without a release; this
 * schema is what makes that safe, because a typo or a missing catch-all tier
 * stops startup instead of silently mis-routing quotes.
 */

/** Quote-level numbers a tier condition can test. */
export const POLICY_METRICS = ["effective_discount_pct", "net_total"] as const;
export type PolicyMetric = (typeof POLICY_METRICS)[number];

const ConditionSchema = z
  .object({
    metric: z.enum(POLICY_METRICS),
    op: z.enum(["gt", "gte", "lt", "lte"]),
    // Thresholds become Decimal so comparisons with money never touch floats.
    value: z.number().transform((v) => new Decimal(String(v))),
  })
  .strict();
export type PolicyCondition = z.output<typeof ConditionSchema>;

const TierSchema = z
  .object({
    name: z.string().min(1),
    /** Who approves after the specialist; null means specialist sign-off only. */
    approver_role: z.enum(ROLES).nullable(),
    /** Pick the approver whose region is the customer's (regional managers). */
    match_customer_region: z.boolean().default(false),
    /** Tier matches if ANY condition holds. */
    any: z.array(ConditionSchema).min(1).optional(),
    /** Catch-all tier. */
    always: z.literal(true).optional(),
  })
  .strict()
  .refine((t) => (t.always === true) !== (t.any !== undefined), {
    message: "a tier needs exactly one of `always: true` or a non-empty `any` list",
  })
  .refine((t) => t.approver_role !== Role.QuoteSpecialist, {
    message: "quote_specialist always signs off first; use approver_role: null for specialist-only",
  });
export type PolicyTier = z.output<typeof TierSchema>;

export const ApprovalPolicySchema = z
  .object({
    version: z.union([z.string().min(1), z.number()]).transform(String),
    tiers: z.array(TierSchema).min(1),
    thresholds: z
      .object({
        min_confidence: z.number().min(0).max(1),
        max_stock_age_hours: z.number().positive(),
        max_export_age_hours: z.number().positive(),
        duplicate_window_hours: z.number().positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const last = policy.tiers.at(-1);
    if (last?.always !== true) {
      ctx.addIssue({ code: "custom", path: ["tiers"], message: "the last tier must be `always: true` so every quote routes" });
    }
    policy.tiers.slice(0, -1).forEach((t, i) => {
      if (t.always === true) {
        ctx.addIssue({ code: "custom", path: ["tiers", i], message: "only the last tier may be `always: true`" });
      }
    });
    const names = policy.tiers.map((t) => t.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", path: ["tiers"], message: "tier names must be unique" });
    }
  });

/** The validated approval policy. */
export type ApprovalPolicy = z.output<typeof ApprovalPolicySchema>;
/** Review thresholds from the policy (rules 8, 10, 11). */
export type PolicyThresholds = ApprovalPolicy["thresholds"];
