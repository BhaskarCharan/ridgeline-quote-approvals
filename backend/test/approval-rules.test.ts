import { Decimal } from "decimal.js";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/adapters/clock/fixed-clock.js";
import { InMemoryReferenceData } from "../src/adapters/in-memory-reference-data.js";
import { QuoteStatus, Role } from "../src/domain/enums.js";
import type { Approver, RoutingResult } from "../src/domain/models.js";
import { ApproverResolver } from "../src/services/routing/approver-resolver.js";
import { RuleEngine } from "../src/services/routing/rule-engine.js";
import { createHarness, type Harness } from "./support/harness.js";

/**
 * Acceptance tests for the approval rules (TASK.md Part 3.4), asserting the
 * results verified by hand against the sample data.
 *
 * Fully offline: in-memory repositories, a fake StockProvider backed by
 * stock_fixture.json, and a FixedClock at the policy time (Mon 2026-10-12
 * 09:30 Central). No MongoDB, no network.
 */

/** The full expected output for the 10 sample drafts, verified by hand. */
const EXPECTED_ROUTING: RoutingResult[] = [
  { draft_id: "DQ-24101", status: "specialist_only", net_total: 435.23, effective_discount_pct: 8, approver_id: null, specialist_review_flags: [], duplicate_of: null },
  { draft_id: "DQ-24102", status: "approver_required", net_total: 132.46, effective_discount_pct: 18, approver_id: "U01", specialist_review_flags: [], duplicate_of: null },
  { draft_id: "DQ-24103", status: "approver_required", net_total: 728.8, effective_discount_pct: 26.22, approver_id: "U05", specialist_review_flags: [{ line: 3, reason: "part not found in stock API" }], duplicate_of: null },
  { draft_id: "DQ-24104", status: "approver_required", net_total: 2191, effective_discount_pct: 30, approver_id: "U05", specialist_review_flags: [{ line: 1, reason: "stale stock reading: 49.5h old (as of 2026-10-10T08:00:00-05:00)" }], duplicate_of: null },
  { draft_id: "DQ-24105", status: "specialist_only", net_total: 471.2, effective_discount_pct: 5, approver_id: null, specialist_review_flags: [{ line: 3, reason: "extraction confidence 0.62" }], duplicate_of: null },
  { draft_id: "DQ-24106", status: "approver_required", net_total: 47652, effective_discount_pct: 5, approver_id: "U04", specialist_review_flags: [], duplicate_of: null },
  { draft_id: "DQ-24107", status: "approver_required", net_total: 456.54, effective_discount_pct: 15.38, approver_id: "U01", specialist_review_flags: [{ line: 1, reason: "contract price expired 2025-12-31; list price used" }], duplicate_of: null },
  { draft_id: "DQ-24108", status: "specialist_only", net_total: 1517.4, effective_discount_pct: 10, approver_id: null, specialist_review_flags: [{ line: 1, reason: "out of stock in all warehouses" }], duplicate_of: null },
  { draft_id: "DQ-24109", status: "approver_required", net_total: 1409.86, effective_discount_pct: 18.36, approver_id: "U04", specialist_review_flags: [{ line: 3, reason: "extraction confidence 0.79" }, { line: 6, reason: "stale stock reading: 49.5h old (as of 2026-10-10T08:00:00-05:00)" }], duplicate_of: null },
  { draft_id: "DQ-24110", status: "duplicate", net_total: null, effective_discount_pct: null, approver_id: null, specialist_review_flags: [], duplicate_of: "DQ-24102" },
];

describe("Approval rules on the sample drafts", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  const route = async (draftId: string) => (await h.processor.process(h.draft(draftId))).quote;

  it("produces exactly the hand-verified routing for all 10 drafts, in file order", async () => {
    const results = await h.processor.processBatch(h.drafts);
    expect(results.map((r) => r.quote.routing)).toEqual(EXPECTED_ROUTING);
  });

  describe("tiers", () => {
    it("specialist only: discount <= 15% and net < $25k (DQ-24101: 8%, $435.23)", async () => {
      const quote = await route("DQ-24101");
      expect(quote.tier).toBe("specialist_only");
      expect(quote.routing).toMatchObject({ status: "specialist_only", approver_id: null, net_total: 435.23 });
      // A person still signs off: the specialist.
      expect(quote.status).toBe(QuoteStatus.PendingSpecialist);
    });

    it("regional manager: discount over 15% routes to the customer's region (DQ-24102: 18%, West -> U01)", async () => {
      const quote = await route("DQ-24102");
      expect(quote.tier).toBe("regional_manager");
      expect(quote.routing).toMatchObject({ status: "approver_required", approver_id: "U01", effective_discount_pct: 18 });
    });

    it("regional manager: contract prices push 12% proposed to 15.38% effective (DQ-24107 -> U01)", async () => {
      const quote = await route("DQ-24107");
      expect(quote.tier).toBe("regional_manager");
      expect(quote.routing).toMatchObject({ approver_id: "U01", effective_discount_pct: 15.38 });
    });

    it("VP: discount over 25% (DQ-24104: 30% -> U05)", async () => {
      const quote = await route("DQ-24104");
      expect(quote.tier).toBe("vp_sales");
      expect(quote.routing).toMatchObject({ approver_id: "U05", effective_discount_pct: 30 });
    });

    it("VP: contract prices push 22% proposed to 26.22% effective (DQ-24103 -> U05)", async () => {
      const quote = await route("DQ-24103");
      expect(quote.tier).toBe("vp_sales");
      expect(quote.routing).toMatchObject({ approver_id: "U05", effective_discount_pct: 26.22, net_total: 728.8 });
    });
  });

  describe("$25k rule", () => {
    it("routes a low-discount, high-value quote to the regional manager (DQ-24106: 5%, $47,652)", async () => {
      const quote = await route("DQ-24106");
      expect(quote.routing).toMatchObject({ effective_discount_pct: 5, net_total: 47652, status: "approver_required" });
      expect(quote.tier).toBe("regional_manager");
    });

    it("applies the thresholds exactly at the boundaries, from the policy YAML", () => {
      const engine = new RuleEngine(h.policy.tiers);
      const tier = (pct: string, net: string) =>
        engine.evaluate({ effective_discount_pct: new Decimal(pct), net_total: new Decimal(net) }).name;

      expect(tier("15", "24999.99")).toBe("specialist_only"); // 15% or less AND under $25k
      expect(tier("15", "25000")).toBe("regional_manager"); // $25,000 or more
      expect(tier("15.0001", "100")).toBe("regional_manager"); // over 15%
      expect(tier("25", "100")).toBe("regional_manager"); // up to 25%
      expect(tier("25.0001", "100")).toBe("vp_sales"); // over 25%
      expect(tier("30", "50000")).toBe("vp_sales"); // VP wins over the $25k rule
    });
  });

  describe("backup approver", () => {
    it("routes to the backup when the regional manager is out of office (DQ-24106: U02 out -> U04)", async () => {
      const quote = await route("DQ-24106");
      expect(quote.approverPath).toEqual(["U02", "U04"]);
      expect(quote.routing.approver_id).toBe("U04");
    });

    it("follows backups past several absent approvers, and stops on a loop", () => {
      const out = { out_of_office_from: "2026-10-12", out_of_office_to: "2026-10-12" };
      const approver = (id: string, backup: string | null, extra: Partial<Approver> = {}): Approver => ({
        approver_id: id,
        name: id,
        role: Role.RegionalManager,
        region: id,
        backup_approver_id: backup,
        out_of_office_from: null,
        out_of_office_to: null,
        ...extra,
      });
      const ref = new InMemoryReferenceData({
        exportedAt: new Date("2026-10-11T07:00:00Z"),
        products: [],
        customers: [],
        contractPrices: [],
        approvers: [
          approver("A", "B", out),
          approver("B", "C", out),
          approver("C", null),
          approver("X", "Y", out),
          approver("Y", "X", out),
        ],
      });
      const resolver = new ApproverResolver(ref, h.clock, { timeZone: "America/Chicago" });

      expect(resolver.followBackups("A")).toEqual({ ok: true, approverId: "C", path: ["A", "B", "C"] });
      expect(resolver.followBackups("X")).toMatchObject({ ok: false, reason: "backup chain loops (X -> Y -> X)" });
    });

    it("treats out-of-office dates as Central calendar days (U02 is back on Oct 17)", async () => {
      const later = await createHarness({ now: "2026-10-17T09:00:00-05:00" });
      const quote = (await later.processor.process(later.draft("DQ-24106"))).quote;
      expect(quote.approverPath).toEqual(["U02"]);
      expect(quote.routing.approver_id).toBe("U02");
    });
  });

  describe("duplicate", () => {
    it("marks the resubmission as a duplicate: null totals and approver, no stock call, stored and audited", async () => {
      await route("DQ-24102");
      const stockCalls = h.stock.calls;

      const quote = await route("DQ-24110");

      expect(quote.routing).toEqual({
        draft_id: "DQ-24110",
        status: "duplicate",
        net_total: null,
        effective_discount_pct: null,
        approver_id: null,
        specialist_review_flags: [],
        duplicate_of: "DQ-24102",
      });
      expect(h.stock.calls).toBe(stockCalls);
      expect((await h.quotes.findById("DQ-24110"))?.status).toBe(QuoteStatus.Duplicate);
      expect(await h.audit.history("DQ-24110")).toMatchObject([
        { actor: "system", action: "quote_created", statusBefore: null, statusAfter: "duplicate" },
      ]);
    });
  });

  describe("data quality flags", () => {
    it("flags an expired contract and prices the line at list (DQ-24107 line 1)", async () => {
      const quote = await route("DQ-24107");
      expect(quote.routing.specialist_review_flags).toContainEqual({
        line: 1,
        reason: "contract price expired 2025-12-31; list price used",
      });
      expect(quote.lines[0]).toMatchObject({ priceSource: "list", baseUnitPrice: "8.40" });
    });

    it("stock unavailable after retries -> flagged for the specialist, not blocked", async () => {
      h.stock.failing = true;
      const quote = await route("DQ-24102");

      expect(quote.routing.specialist_review_flags).toEqual([{ line: null, reason: "stock unavailable after retries" }]);
      // Still priced, routed and waiting for a person: not blocked, not guessed.
      expect(quote.status).toBe(QuoteStatus.PendingSpecialist);
      expect(quote.routing).toMatchObject({ status: "approver_required", approver_id: "U01", net_total: 132.46 });
    });
  });
});

describe("Review API authorisation (supertest)", () => {
  let h: Harness;
  const approve = (id: string, user: string, body: object = {}) =>
    request(h.app).post(`/quotes/${id}/approve`).set("X-User-Id", user).send(body);

  beforeEach(async () => {
    h = await createHarness();
    await h.processor.processBatch(h.drafts);
  });

  it("403 when the preparer approves their own quote (DQ-24101 prepared by S01)", async () => {
    const res = await approve("DQ-24101", "S01");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "forbidden", details: { actor: "S01", preparedBy: "S01" } });
    expect((await h.quotes.findById("DQ-24101"))?.status).toBe(QuoteStatus.PendingSpecialist);
  });

  it("403 when a manager other than the routed one approves (DQ-24102 routed to U01; U03 tries)", async () => {
    expect((await approve("DQ-24102", "S01")).status).toBe(200);
    const res = await approve("DQ-24102", "U03");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "forbidden", details: { routedTo: "U01", actor: "U03" } });
    expect((await h.quotes.findById("DQ-24102"))?.status).toBe(QuoteStatus.PendingApprover);
  });

  it("409 on a double approve from the same screen (stale version)", async () => {
    expect((await approve("DQ-24102", "S01", { version: 1 })).status).toBe(200);
    const res = await approve("DQ-24102", "S03", { version: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "conflict", details: { expectedVersion: 1, currentVersion: 2 } });
  });

  it("409 when the routed approver approves twice", async () => {
    await approve("DQ-24102", "S01");
    expect((await approve("DQ-24102", "U01")).status).toBe(200);
    const res = await approve("DQ-24102", "U01");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("invalid_transition");
    expect((await h.audit.history("DQ-24102")).filter((e) => e.action === "approver_approved")).toHaveLength(1);
  });
});

// Sanity: the fake clock really is the policy time, so date-based rules are deterministic.
it("runs at the policy reference time", () => {
  expect(new FixedClock("2026-10-12T09:30:00-05:00").now().toISOString()).toBe("2026-10-12T14:30:00.000Z");
});
