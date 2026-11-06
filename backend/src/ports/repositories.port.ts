import type { QuoteStatus } from "../domain/enums.js";
import type { AuditEntry, NewAuditEntry, Quote } from "../domain/models.js";

/** Result of an idempotent insert. */
export interface InsertResult {
  /** False when a quote with this draftId already existed; nothing was written. */
  created: boolean;
  /** The stored quote: the new one, or the one that was already there. */
  quote: Quote;
}

/** Filters for listing quotes (e.g. a manager's queue). */
export interface QuoteFilter {
  status?: QuoteStatus;
  /** Quotes routed to this approver (after backups). */
  approverId?: string;
}

/** Fields an update may change. Identity, createdAt and version are managed by the store. */
export type QuoteUpdate = Partial<Omit<Quote, "draftId" | "createdAt" | "version">>;

/** What the caller believes is stored; the update applies only if both still hold. */
export interface UpdatePrecondition {
  version: number;
  status: QuoteStatus;
}

/**
 * Storage for quotes, keyed by draftId.
 *
 * The contract that matters: one draft can never become two quotes. Without
 * multi-document transactions (standalone MongoDB) this rests on the unique
 * draftId index and on single-document conditional writes, which is also how
 * double approvals are prevented (`updateIfUnchanged`).
 */
export interface QuoteRepository {
  /**
   * Insert unless a quote with this draftId exists. Safe under concurrency:
   * two processes inserting the same draft both get `{ quote }`, exactly one
   * gets `created: true`.
   */
  insertIfAbsent(quote: Quote): Promise<InsertResult>;

  findById(draftId: string): Promise<Quote | null>;

  /** Quotes for an RFQ, oldest first; feeds duplicate detection across runs. */
  findByRfqId(rfqId: string): Promise<Quote[]>;

  /** Quotes matching the filter, oldest first. */
  list(filter?: QuoteFilter): Promise<Quote[]>;

  /**
   * Apply `changes` only if the stored version AND status still match
   * `expected`, bumping the version. Returns null when someone else changed it
   * first, so the caller reports a conflict instead of overwriting a decision
   * (two people approving at once: exactly one wins).
   */
  updateIfUnchanged(draftId: string, expected: UpdatePrecondition, changes: QuoteUpdate): Promise<Quote | null>;
}

/**
 * Append-only audit storage (rule 12). Deliberately has no update or delete:
 * an audit trail that can be edited through the application is not an audit
 * trail. (Demo resets go through {@link ResettableStore}, outside this port.)
 */
export interface AuditRepository {
  append(entry: NewAuditEntry): Promise<AuditEntry>;
  /** Entries for one quote, in the order they happened. */
  listForQuote(quoteId: string): Promise<AuditEntry[]>;
}

/**
 * Demo/test-only wipe, kept off the repository ports so no service can call
 * it. Only the CLI's `--reset` and tests use it, via the container.
 */
export interface ResettableStore {
  reset(): Promise<void>;
}
