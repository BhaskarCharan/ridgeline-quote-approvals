import { MongoServerError, type Collection, type Db, type Filter } from "mongodb";
import type { Quote } from "../../domain/models.js";
import type {
  InsertResult,
  QuoteFilter,
  QuoteRepository,
  QuoteUpdate,
  ResettableStore,
  UpdatePrecondition,
} from "../../ports/repositories.port.js";
import { COLLECTIONS } from "./mongo-connection.js";

/** Stored shape: the quote plus `_id`, which is the draftId. */
type QuoteDocument = Quote & { _id: string };

const DUPLICATE_KEY = 11000;

/**
 * MongoDB {@link QuoteRepository}. `_id` is the draftId (plus an explicit unique
 * index on `draftId`), so "one draft -> one quote" is enforced by the database,
 * not just by a read-then-write check that two processes could race past.
 */
export class MongoQuoteRepository implements QuoteRepository, ResettableStore {
  private readonly collection: Collection<QuoteDocument>;

  constructor(db: Db) {
    this.collection = db.collection<QuoteDocument>(COLLECTIONS.quotes);
  }

  /** Create indexes. Idempotent; call once at startup. */
  async ensureIndexes(): Promise<void> {
    await this.collection.createIndexes([
      { key: { draftId: 1 }, name: "uniq_draftId", unique: true },
      { key: { rfqId: 1, receivedAt: 1 }, name: "rfq_received" },
      { key: { status: 1, receivedAt: 1 }, name: "status_received" },
      { key: { "routing.approver_id": 1, status: 1 }, name: "approver_status" },
    ]);
  }

  async insertIfAbsent(quote: Quote): Promise<InsertResult> {
    try {
      await this.collection.insertOne({ _id: quote.draftId, ...quote });
      return { created: true, quote };
    } catch (err: unknown) {
      if (!(err instanceof MongoServerError && err.code === DUPLICATE_KEY)) throw err;
      const existing = await this.findById(quote.draftId);
      if (!existing) throw err; // Should not happen: the key exists but the doc vanished.
      return { created: false, quote: existing };
    }
  }

  async findById(draftId: string): Promise<Quote | null> {
    const doc = await this.collection.findOne({ _id: draftId });
    return doc ? toQuote(doc) : null;
  }

  async findByRfqId(rfqId: string): Promise<Quote[]> {
    return this.find({ rfqId });
  }

  async list(filter: QuoteFilter = {}): Promise<Quote[]> {
    const query: Filter<QuoteDocument> = {};
    if (filter.status !== undefined) query.status = filter.status;
    if (filter.approverId !== undefined) query["routing.approver_id"] = filter.approverId;
    return this.find(query);
  }

  async updateIfUnchanged(draftId: string, expected: UpdatePrecondition, changes: QuoteUpdate): Promise<Quote | null> {
    // Single-document conditional update: atomic without transactions. If the
    // version or status moved, nothing matches and the caller gets null (a conflict).
    const doc = await this.collection.findOneAndUpdate(
      { _id: draftId, version: expected.version, status: expected.status },
      { $set: { ...changes, version: expected.version + 1 } },
      { returnDocument: "after" },
    );
    return doc ? toQuote(doc) : null;
  }

  async reset(): Promise<void> {
    await this.collection.deleteMany({});
  }

  private async find(query: Filter<QuoteDocument>): Promise<Quote[]> {
    const docs = await this.collection.find(query).sort({ receivedAt: 1, _id: 1 }).toArray();
    return docs.map(toQuote);
  }
}

/**
 * Map a stored document to a Quote, upgrading older documents on read:
 * quotes stored before `decisions` existed get an empty list, so they can
 * still be approved without a data migration.
 */
function toQuote({ _id, ...quote }: QuoteDocument): Quote {
  return { ...quote, decisions: quote.decisions ?? [] };
}
