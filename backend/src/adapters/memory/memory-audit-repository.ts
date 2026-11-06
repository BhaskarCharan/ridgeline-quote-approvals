import type { AuditEntry, NewAuditEntry } from "../../domain/models.js";
import type { AuditRepository, ResettableStore } from "../../ports/repositories.port.js";

/** In-memory, append-only {@link AuditRepository} for tests and Mongo-less demos. */
export class MemoryAuditRepository implements AuditRepository, ResettableStore {
  private readonly entries: AuditEntry[] = [];
  private nextId = 1;

  async append(entry: NewAuditEntry): Promise<AuditEntry> {
    const stored: AuditEntry = { ...structuredClone(entry), id: String(this.nextId++) };
    this.entries.push(stored);
    return structuredClone(stored);
  }

  async listForQuote(quoteId: string): Promise<AuditEntry[]> {
    return this.entries.filter((e) => e.quoteId === quoteId).map((e) => structuredClone(e));
  }

  async reset(): Promise<void> {
    this.entries.length = 0;
    this.nextId = 1;
  }
}
