/**
 * Lifecycle of a quote inside this service. Modelled as a const object plus a
 * union type (not a TS `enum`) so values are plain strings in MongoDB, in JSON
 * output and in the audit log, with no runtime enum emit.
 *
 * Why so many states: the policy requires a specialist on *every* quote, and a
 * second approver only on some, so "approved" must never be reachable without
 * passing through specialist review first.
 */
export const QuoteStatus = {
  /** Waiting for a quote specialist. Every non-duplicate quote starts here. */
  PendingSpecialist: "pending_specialist",
  /** Specialist signed off; waiting for the routed manager / VP. */
  PendingApprover: "pending_approver",
  /** Fully approved: the only state from which a quote may go to a customer. */
  Approved: "approved",
  /** Rejected by the specialist or the approver. Terminal. */
  Rejected: "rejected",
  /** Same RFQ + same lines as a recent draft. No approval request is created. */
  Duplicate: "duplicate",
} as const;
export type QuoteStatus = (typeof QuoteStatus)[keyof typeof QuoteStatus];

/**
 * Routing decision written to `outputs/routing_results.json`. Kept separate from
 * {@link QuoteStatus} because the deliverable's vocabulary describes *who must
 * approve*, while QuoteStatus describes *where the quote is now*.
 */
export const RoutingOutcome = {
  SpecialistOnly: "specialist_only",
  ApproverRequired: "approver_required",
  Duplicate: "duplicate",
} as const;
export type RoutingOutcome = (typeof RoutingOutcome)[keyof typeof RoutingOutcome];

/**
 * Roles exactly as they appear in `reporting_db/approvers.csv`, so the CSV can
 * be parsed straight into this type and policy YAML can reference them by name.
 */
export const Role = {
  QuoteSpecialist: "quote_specialist",
  RegionalManager: "regional_manager",
  SalesOperationsDirector: "sales_operations_director",
  VpSales: "vp_sales",
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** Every Role value, for zod enums and CSV validation. */
export const ROLES = Object.values(Role) as [Role, ...Role[]];

/** Every QuoteStatus value, for zod enums and query validation. */
export const QUOTE_STATUSES = Object.values(QuoteStatus) as [QuoteStatus, ...QuoteStatus[]];

/**
 * Every action the audit log can record. A closed set, so reports can count
 * actions reliably and a typo cannot invent a new one.
 */
export const AuditAction = {
  QuoteCreated: "quote_created",
  SpecialistApproved: "specialist_approved",
  ApproverApproved: "approver_approved",
  Rejected: "rejected",
  Edited: "edited",
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
