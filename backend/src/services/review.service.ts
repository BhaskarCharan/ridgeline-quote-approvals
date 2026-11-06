import { Role } from "../domain/enums.js";
import {
  ConflictError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
} from "../domain/errors.js";
import type { Approver, AuditEntry, FieldChange, Quote, ReviewDecision } from "../domain/models.js";
import { findTransition, type ReviewAction, type Transition } from "../domain/workflow.js";
import type { Clock } from "../ports/clock.js";
import type { QuoteFilter, QuoteRepository } from "../ports/repositories.port.js";
import type { AuditService } from "./audit.service.js";

/** Options for approve/reject. */
export interface DecisionOptions {
  /**
   * The version the reviewer was looking at. When given, a mismatch is a 409
   * before anything else, so a double-click or a stale screen cannot approve
   * something that changed underneath the reviewer.
   */
  expectedVersion?: number;
  /** Rejection reason (required by the API for reject) or approval comment. */
  reason?: string;
}

/**
 * The human review workflow: list quotes, and approve or reject them.
 *
 * Every decision goes through the same four gates, in order:
 *   1. optimistic version check (stale screen -> 409)
 *   2. is this action allowed from the current status? (WORKFLOW table -> 409)
 *   3. is this person allowed to take this step? (-> 403)
 *   4. conditional write on {version, status} (lost race -> 409)
 * and every successful decision is audited.
 */
export class QuoteReviewService {
  constructor(
    private readonly quotes: QuoteRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  list(filter: QuoteFilter = {}): Promise<Quote[]> {
    return this.quotes.list(filter);
  }

  /** One quote, or NotFoundError. */
  async get(draftId: string): Promise<Quote> {
    const quote = await this.quotes.findById(draftId);
    if (!quote) throw new NotFoundError(`Quote ${draftId} not found`, { quoteId: draftId });
    return quote;
  }

  /** Audit history for an existing quote, oldest first. */
  async history(draftId: string): Promise<AuditEntry[]> {
    await this.get(draftId);
    return this.audit.history(draftId);
  }

  /** Approve the step that is currently pending, as `actor`. */
  approve(draftId: string, actor: Approver, options: DecisionOptions = {}): Promise<Quote> {
    return this.decide(draftId, actor, "approve", options);
  }

  /** Reject the quote at its current step, as `actor`. */
  reject(draftId: string, actor: Approver, options: DecisionOptions & { reason: string }): Promise<Quote> {
    return this.decide(draftId, actor, "reject", options);
  }

  private async decide(
    draftId: string,
    actor: Approver,
    action: ReviewAction,
    options: DecisionOptions,
  ): Promise<Quote> {
    const quote = await this.get(draftId);

    if (options.expectedVersion !== undefined && options.expectedVersion !== quote.version) {
      throw new ConflictError("Quote has changed since you loaded it; reload and try again", {
        quoteId: draftId,
        expectedVersion: options.expectedVersion,
        currentVersion: quote.version,
        currentStatus: quote.status,
      });
    }

    const transition = findTransition(quote.status, action);
    if (!transition) {
      throw new InvalidTransitionError(`Cannot ${action} a quote in status ${quote.status}`, {
        quoteId: draftId,
        status: quote.status,
        action,
      });
    }

    authorize(transition, quote, actor);

    const now = this.clock.now().toISOString();
    const statusAfter = transition.to(quote);
    const decision: ReviewDecision = {
      step: transition.step,
      decision: action === "approve" ? "approved" : "rejected",
      by: actor.approver_id,
      at: now,
      reason: options.reason ?? null,
    };

    const updated = await this.quotes.updateIfUnchanged(
      draftId,
      { version: quote.version, status: quote.status },
      { status: statusAfter, decisions: [...quote.decisions, decision], updatedAt: now },
    );
    if (!updated) {
      // Someone else's decision landed between our read and our write.
      throw new ConflictError("Quote was changed by someone else; reload and try again", {
        quoteId: draftId,
        expectedVersion: quote.version,
        expectedStatus: quote.status,
      });
    }

    const changes: Record<string, FieldChange> = {
      status: { before: quote.status, after: statusAfter },
      version: { before: quote.version, after: updated.version },
    };
    if (options.reason !== undefined) {
      changes[action === "reject" ? "rejectionReason" : "comment"] = { before: null, after: options.reason };
    }
    await this.audit.record({
      actor: actor.approver_id,
      action: transition.audit,
      quoteId: draftId,
      statusBefore: quote.status,
      statusAfter,
      changes,
    });

    return updated;
  }
}

/**
 * Who may act at each step:
 * - specialist step: any quote_specialist except the one who prepared the
 *   quote (four eyes: nobody approves their own work);
 * - approver step: only the approver the quote was routed to (after backups).
 */
function authorize(transition: Transition, quote: Quote, actor: Approver): void {
  if (transition.step === "specialist") {
    if (actor.role !== Role.QuoteSpecialist) {
      throw new ForbiddenError("Only a quote specialist can act at the specialist step", {
        quoteId: quote.draftId,
        actor: actor.approver_id,
        role: actor.role,
      });
    }
    if (actor.approver_id === quote.preparedBy) {
      throw new ForbiddenError("The specialist who prepared a quote cannot sign it off", {
        quoteId: quote.draftId,
        actor: actor.approver_id,
        preparedBy: quote.preparedBy,
      });
    }
    return;
  }

  const routedTo = quote.routing.approver_id;
  if (routedTo === null || actor.approver_id !== routedTo) {
    throw new ForbiddenError(
      routedTo === null
        ? "No approver could be resolved for this quote; it needs manual reassignment"
        : `Only the routed approver (${routedTo}) can act at this step`,
      { quoteId: quote.draftId, actor: actor.approver_id, routedTo },
    );
  }
}
