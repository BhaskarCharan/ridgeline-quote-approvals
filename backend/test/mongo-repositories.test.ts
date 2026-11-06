import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoAuditRepository } from "../src/adapters/mongo/mongo-audit-repository.js";
import { MongoQuoteRepository } from "../src/adapters/mongo/mongo-quote-repository.js";
import { AuditAction, QuoteStatus } from "../src/domain/enums.js";
import type { Quote } from "../src/domain/models.js";
import { createHarness } from "./support/harness.js";

/**
 * Integration tests against a real local MongoDB, in a throwaway database.
 * Skipped (not failed) when Mongo is not reachable, so `npm test` still works
 * on a machine without it.
 */
const MONGO_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const TEST_DB = `ridgeline_quotes_test_${process.pid}`;

async function tryConnect(): Promise<MongoClient | null> {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 1000 });
  try {
    await client.connect();
    return client;
  } catch {
    await client.close().catch(() => {});
    return null;
  }
}

const client = await tryConnect();

describe.skipIf(client === null)("Mongo repositories (integration)", () => {
  let db: Db;
  let quotes: MongoQuoteRepository;
  let audit: MongoAuditRepository;
  let sample: Quote;

  beforeAll(async () => {
    db = client!.db(TEST_DB);
    quotes = new MongoQuoteRepository(db);
    audit = new MongoAuditRepository(db);
    await Promise.all([quotes.ensureIndexes(), audit.ensureIndexes()]);
    // A realistic quote, produced by the real pipeline on in-memory stores.
    const h = await createHarness();
    sample = (await h.processor.process(h.draft("DQ-24106"))).quote;
  });

  beforeEach(async () => {
    await Promise.all([quotes.reset(), audit.reset()]);
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
  });

  it("round-trips a quote unchanged, keyed by draftId", async () => {
    expect(await quotes.insertIfAbsent(sample)).toEqual({ created: true, quote: sample });
    expect(await quotes.findById("DQ-24106")).toEqual(sample);
    const raw = await db.collection("quotes").findOne({ draftId: "DQ-24106" });
    expect(raw?._id).toBe("DQ-24106");
  });

  it("reads quotes stored before `decisions` existed as having no decisions", async () => {
    const { decisions: _omit, ...legacy } = sample;
    await db.collection("quotes").insertOne({ _id: "DQ-LEGACY", ...legacy, draftId: "DQ-LEGACY" } as never);
    expect((await quotes.findById("DQ-LEGACY"))?.decisions).toEqual([]);
  });

  it("has a unique index on draftId", async () => {
    const indexes = await db.collection("quotes").indexes();
    expect(indexes.find((i) => i.name === "uniq_draftId")).toMatchObject({ key: { draftId: 1 }, unique: true });
  });

  it("lets exactly one of many concurrent inserts of the same draft win", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => quotes.insertIfAbsent(sample)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.every((r) => r.quote.draftId === "DQ-24106")).toBe(true);
    expect(await db.collection("quotes").countDocuments()).toBe(1);
  });

  it("filters by status and approver", async () => {
    await quotes.insertIfAbsent(sample);
    expect(await quotes.list({ approverId: "U04", status: QuoteStatus.PendingSpecialist })).toHaveLength(1);
    expect(await quotes.list({ approverId: "U01" })).toHaveLength(0);
    expect(await quotes.findByRfqId(sample.rfqId)).toHaveLength(1);
  });

  it("updates only when version and status match (no double approvals)", async () => {
    await quotes.insertIfAbsent(sample);
    const expected = { version: 1, status: QuoteStatus.PendingSpecialist };
    const [a, b] = await Promise.all([
      quotes.updateIfUnchanged("DQ-24106", expected, { status: QuoteStatus.PendingApprover }),
      quotes.updateIfUnchanged("DQ-24106", expected, { status: QuoteStatus.Rejected }),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.version).toBe(2);
    expect((await quotes.findById("DQ-24106"))?.version).toBe(2);
  });

  it("appends audit entries and lists them in order with ids", async () => {
    const base = { actor: "system", quoteId: "DQ-24106", changes: {} } as const;
    await audit.append({ ...base, action: AuditAction.QuoteCreated, statusBefore: null, statusAfter: QuoteStatus.PendingSpecialist, at: "2026-10-12T14:30:00.000Z" });
    await audit.append({ ...base, actor: "S03", action: AuditAction.SpecialistApproved, statusBefore: QuoteStatus.PendingSpecialist, statusAfter: QuoteStatus.PendingApprover, at: "2026-10-12T14:31:00.000Z" });

    const history = await audit.listForQuote("DQ-24106");
    expect(history.map((e) => e.action)).toEqual(["quote_created", "specialist_approved"]);
    expect(history.every((e) => /^[0-9a-f]{24}$/.test(e.id))).toBe(true);
  });
});
