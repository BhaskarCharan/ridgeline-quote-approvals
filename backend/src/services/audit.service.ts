import type { AuditAction, QuoteStatus } from "../domain/enums.js";
import type { AuditEntry, FieldChange } from "../domain/models.js";
import type { Clock } from "../ports/clock.js";
import type { AuditRepository } from "../ports/repositories.port.js";

/** What a caller supplies; the service stamps the time. */
export interface AuditInput {
  actor: string;
  action: AuditAction;
  quoteId: string;
  statusBefore: QuoteStatus | null;
  statusAfter: QuoteStatus | null;
  changes?: Record<string, FieldChange>;
}

/**
 * Records every action on a quote (rule 12: who, what, when, before/after).
 * Timestamps come from the injected Clock, never from the caller, so entries
 * are consistent with every other time-based decision and cannot be backdated.
 * Append-only: there is no way to change or remove an entry through here.
 */
export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly clock: Clock,
  ) {}

  /** Append one entry. */
  record(input: AuditInput): Promise<AuditEntry> {
    return this.repository.append({
      actor: input.actor,
      action: input.action,
      quoteId: input.quoteId,
      statusBefore: input.statusBefore,
      statusAfter: input.statusAfter,
      changes: input.changes ?? {},
      at: this.clock.now().toISOString(),
    });
  }

  /** The full history of one quote, oldest first. */
  history(quoteId: string): Promise<AuditEntry[]> {
    return this.repository.listForQuote(quoteId);
  }
}
