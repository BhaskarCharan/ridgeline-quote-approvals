import { beforeEach, describe, expect, it } from "vitest";
import { AuditAction, QuoteStatus } from "../src/domain/enums.js";
import { SYSTEM_ACTOR } from "../src/services/quote-processor.js";
import { createHarness, POLICY_NOW, type Harness } from "./support/harness.js";

describe("QuoteProcessor persistence", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });

  it("stores a quote keyed by draftId at pending_specialist, version 1, with its routing", async () => {
    const { quote, created } = await h.processor.process(h.draft("DQ-24106"));

    expect(created).toBe(true);
    expect(quote.draftId).toBe("DQ-24106");
    expect(quote.status).toBe(QuoteStatus.PendingSpecialist);
    expect(quote.version).toBe(1);
    expect(quote.routing).toMatchObject({ status: "approver_required", approver_id: "U04", net_total: 47652 });
    expect(quote.approverPath).toEqual(["U02", "U04"]); // U02 out of office -> backup
    expect(quote.netTotal).toBe("47652.00");
    expect(await h.quotes.findById("DQ-24106")).toEqual(quote);
  });

  it("puts even specialist-only quotes at pending_specialist (a person always approves)", async () => {
    const { quote } = await h.processor.process(h.draft("DQ-24101"));
    expect(quote.routing.status).toBe("specialist_only");
    expect(quote.status).toBe(QuoteStatus.PendingSpecialist);
  });

  it("audits creation as actor 'system', action 'quote_created', null -> status", async () => {
    await h.processor.process(h.draft("DQ-24102"));
    const history = await h.audit.history("DQ-24102");

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      actor: SYSTEM_ACTOR,
      action: AuditAction.QuoteCreated,
      quoteId: "DQ-24102",
      statusBefore: null,
      statusAfter: QuoteStatus.PendingSpecialist,
      at: new Date(POLICY_NOW).toISOString(),
    });
    expect(history[0]?.changes.approverId).toEqual({ before: null, after: "U01" });
  });

  it("is a no-op when the same draftId is processed again: no stock call, no audit, same quote", async () => {
    const first = await h.processor.process(h.draft("DQ-24103"));
    const callsAfterFirst = h.stock.calls;

    const second = await h.processor.process(h.draft("DQ-24103"));

    expect(second.created).toBe(false);
    expect(second.quote).toEqual(first.quote);
    expect(h.stock.calls).toBe(callsAfterFirst);
    expect(await h.audit.history("DQ-24103")).toHaveLength(1);
  });

  it("ignores a changed payload re-sent under an existing draftId", async () => {
    await h.processor.process(h.draft("DQ-24101"));
    const changed = { ...h.draft("DQ-24101"), proposed_discount_pct: 40 };
    const { quote, created } = await h.processor.process(changed);
    expect(created).toBe(false);
    expect(quote.routing.status).toBe("specialist_only");
  });

  it("stores a resubmission as status 'duplicate' pointing at the original, without a stock call", async () => {
    await h.processor.process(h.draft("DQ-24102"));
    const calls = h.stock.calls;

    const { quote } = await h.processor.process(h.draft("DQ-24110"));

    expect(quote.status).toBe(QuoteStatus.Duplicate);
    expect(quote.routing).toMatchObject({ status: "duplicate", duplicate_of: "DQ-24102", approver_id: null });
    expect(h.stock.calls).toBe(calls);
    expect((await h.audit.history("DQ-24110"))[0]?.statusAfter).toBe(QuoteStatus.Duplicate);
  });

  it("detects duplicates across separate runs because originals come from the repository", async () => {
    await h.processor.processBatch([h.draft("DQ-24102")]); // run 1
    const [result] = await h.processor.processBatch([h.draft("DQ-24110")]); // run 2
    expect(result?.quote.routing.duplicate_of).toBe("DQ-24102");
  });

  it("processes the whole sample batch in file order", async () => {
    const results = await h.processor.processBatch(h.drafts);
    expect(results.map((r) => r.quote.draftId)).toEqual(h.drafts.map((d) => d.draft_id));
    expect(results.every((r) => r.created)).toBe(true);
    expect(await h.quotes.list({ status: QuoteStatus.Duplicate })).toHaveLength(1);
    expect((await h.quotes.list({ approverId: "U04" })).map((q) => q.draftId)).toEqual(["DQ-24106", "DQ-24109"]);
  });
});

describe("MemoryQuoteRepository.updateIfUnchanged", () => {
  it("applies an update once and rejects a second writer holding the stale version", async () => {
    const h = await createHarness();
    const { quote } = await h.processor.process(h.draft("DQ-24101"));

    const expected = { version: 1, status: QuoteStatus.PendingSpecialist };
    const first = await h.quotes.updateIfUnchanged(quote.draftId, expected, { status: QuoteStatus.Approved });
    const second = await h.quotes.updateIfUnchanged(quote.draftId, expected, { status: QuoteStatus.Rejected });

    expect(first?.version).toBe(2);
    expect(second).toBeNull();
    expect((await h.quotes.findById(quote.draftId))?.status).toBe(QuoteStatus.Approved);
  });

  it("rejects an update whose expected status is stale even if the version matches", async () => {
    const h = await createHarness();
    const { quote } = await h.processor.process(h.draft("DQ-24101"));
    const result = await h.quotes.updateIfUnchanged(
      quote.draftId,
      { version: 1, status: QuoteStatus.PendingApprover },
      { status: QuoteStatus.Approved },
    );
    expect(result).toBeNull();
  });
});
