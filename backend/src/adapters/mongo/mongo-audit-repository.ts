import type { Collection, Db, ObjectId } from "mongodb";
import type { AuditEntry, NewAuditEntry } from "../../domain/models.js";
import type { AuditRepository, ResettableStore } from "../../ports/repositories.port.js";
import { COLLECTIONS } from "./mongo-connection.js";

type AuditDocument = NewAuditEntry & { _id?: ObjectId };

/**
 * MongoDB append-only {@link AuditRepository}. The application only ever calls
 * insertOne here. In production the service's database user would also be
 * granted insert/find only on this collection, so even a bug cannot rewrite
 * history.
 */
export class MongoAuditRepository implements AuditRepository, ResettableStore {
  private readonly collection: Collection<AuditDocument>;

  constructor(db: Db) {
    this.collection = db.collection<AuditDocument>(COLLECTIONS.audit);
  }

  /** Create indexes. Idempotent; call once at startup. */
  async ensureIndexes(): Promise<void> {
    await this.collection.createIndexes([{ key: { quoteId: 1, at: 1, _id: 1 }, name: "quote_at" }]);
  }

  async append(entry: NewAuditEntry): Promise<AuditEntry> {
    // Copy first: insertOne mutates its argument by adding _id.
    const doc: AuditDocument = { ...entry };
    const { insertedId } = await this.collection.insertOne(doc);
    return { ...entry, id: insertedId.toHexString() };
  }

  async listForQuote(quoteId: string): Promise<AuditEntry[]> {
    // ObjectIds increase over time, so _id breaks ties between same-millisecond entries.
    const docs = await this.collection.find({ quoteId }).sort({ at: 1, _id: 1 }).toArray();
    return docs.map(({ _id, ...entry }) => ({ ...entry, id: _id?.toHexString() ?? "" }));
  }

  async reset(): Promise<void> {
    await this.collection.deleteMany({});
  }
}
