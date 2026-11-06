import type { Quote } from "../../domain/models.js";
import type {
  InsertResult,
  QuoteFilter,
  QuoteRepository,
  QuoteUpdate,
  ResettableStore,
  UpdatePrecondition,
} from "../../ports/repositories.port.js";

/**
 * In-memory {@link QuoteRepository} for tests and Mongo-less demos. Mirrors the
 * Mongo adapter's semantics (idempotent insert, version check), and clones on
 * the way in and out so callers can never mutate stored state by reference,
 * which would hide bugs that the real database would expose.
 */
export class MemoryQuoteRepository implements QuoteRepository, ResettableStore {
  private readonly quotes = new Map<string, Quote>();

  async insertIfAbsent(quote: Quote): Promise<InsertResult> {
    const existing = this.quotes.get(quote.draftId);
    if (existing) return { created: false, quote: structuredClone(existing) };
    this.quotes.set(quote.draftId, structuredClone(quote));
    return { created: true, quote: structuredClone(quote) };
  }

  async findById(draftId: string): Promise<Quote | null> {
    const quote = this.quotes.get(draftId);
    return quote ? structuredClone(quote) : null;
  }

  async findByRfqId(rfqId: string): Promise<Quote[]> {
    return this.sorted([...this.quotes.values()].filter((q) => q.rfqId === rfqId));
  }

  async list(filter: QuoteFilter = {}): Promise<Quote[]> {
    return this.sorted(
      [...this.quotes.values()].filter(
        (q) =>
          (filter.status === undefined || q.status === filter.status) &&
          (filter.approverId === undefined || q.routing.approver_id === filter.approverId),
      ),
    );
  }

  async updateIfUnchanged(draftId: string, expected: UpdatePrecondition, changes: QuoteUpdate): Promise<Quote | null> {
    const current = this.quotes.get(draftId);
    if (!current || current.version !== expected.version || current.status !== expected.status) return null;
    const updated: Quote = { ...current, ...structuredClone(changes), version: expected.version + 1 };
    this.quotes.set(draftId, updated);
    return structuredClone(updated);
  }

  async reset(): Promise<void> {
    this.quotes.clear();
  }

  private sorted(quotes: Quote[]): Quote[] {
    return quotes
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.draftId.localeCompare(b.draftId))
      .map((q) => structuredClone(q));
  }
}
