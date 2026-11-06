import { AuditAction, QuoteStatus, RoutingOutcome } from "./enums.js";
import type { Quote, ReviewStep } from "./models.js";

/** What a reviewer can do to a quote. */
export type ReviewAction = "approve" | "reject";

/** One allowed move in the workflow. */
export interface Transition {
  /** Whose turn it is: decides who may perform the action. */
  step: ReviewStep;
  /** Target status; may depend on the routing (specialist-only skips the approver). */
  to: (quote: Quote) => QuoteStatus;
  /** What the audit log records. */
  audit: AuditAction;
}

/**
 * THE workflow: every allowed transition, in one table. Anything not listed is
 * refused (409), which is how "no quote reaches a customer without human
 * approval" is enforced: the only path to `approved` passes through a
 * specialist sign-off, plus the routed approver when the tier requires one.
 *
 *   pending_specialist --approve(specialist)--> pending_approver | approved (specialist_only)
 *   pending_specialist --reject(specialist)---> rejected
 *   pending_approver   --approve(approver)----> approved
 *   pending_approver   --reject(approver)-----> rejected
 *   approved, rejected, duplicate: terminal
 */
export const WORKFLOW: Readonly<Record<QuoteStatus, Readonly<Partial<Record<ReviewAction, Transition>>>>> = {
  [QuoteStatus.PendingSpecialist]: {
    approve: {
      step: "specialist",
      to: (q) =>
        q.routing.status === RoutingOutcome.SpecialistOnly ? QuoteStatus.Approved : QuoteStatus.PendingApprover,
      audit: AuditAction.SpecialistApproved,
    },
    reject: { step: "specialist", to: () => QuoteStatus.Rejected, audit: AuditAction.Rejected },
  },
  [QuoteStatus.PendingApprover]: {
    approve: { step: "approver", to: () => QuoteStatus.Approved, audit: AuditAction.ApproverApproved },
    reject: { step: "approver", to: () => QuoteStatus.Rejected, audit: AuditAction.Rejected },
  },
  [QuoteStatus.Approved]: {},
  [QuoteStatus.Rejected]: {},
  [QuoteStatus.Duplicate]: {},
};

/** The transition for `action` from the quote's current status, if one is allowed. */
export function findTransition(status: QuoteStatus, action: ReviewAction): Transition | undefined {
  return WORKFLOW[status][action];
}
