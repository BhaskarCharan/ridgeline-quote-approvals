import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { QuoteStatus } from "../src/domain/enums.js";
import { ConflictError } from "../src/domain/errors.js";
import type { Approver } from "../src/domain/models.js";
import { createHarness, type Harness } from "./support/harness.js";

/**
 * Sample-data facts these tests rely on:
 * - DQ-24101: prepared by S01, specialist_only
 * - DQ-24102: prepared by S02, routed to U01 (West RM)
 * - DQ-24106: prepared by S03, routed to U04 because U02 is out of office
 * - DQ-24109: prepared by S03, routed to U04
 * - DQ-24110: duplicate of DQ-24102
 */
describe("Review API", () => {
  let h: Harness;
  const as = (userId: string) => ({ "X-User-Id": userId });
  const approve = (id: string, user: string, body: object = {}) =>
    request(h.app).post(`/quotes/${id}/approve`).set(as(user)).send(body);
  const reject = (id: string, user: string, body: object) =>
    request(h.app).post(`/quotes/${id}/reject`).set(as(user)).send(body);

  beforeEach(async () => {
    h = await createHarness();
    await h.processor.processBatch(h.drafts);
  });

  describe("auth", () => {
    it("returns 401 without X-User-Id, in the standard error shape", async () => {
      const res = await request(h.app).get("/quotes");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: "unauthenticated", message: "Missing X-User-Id header", details: {} });
    });

    it("returns 401 for an unknown user", async () => {
      const res = await request(h.app).get("/quotes").set(as("NOBODY"));
      expect(res.status).toBe(401);
      expect(res.body.details).toEqual({ userId: "NOBODY" });
    });

    it("keeps /health public", async () => {
      expect((await request(h.app).get("/health")).status).toBe(200);
    });

    it("allows the Angular dev origin via CORS, including the X-User-Id header", async () => {
      const res = await request(h.app)
        .options("/quotes")
        .set("Origin", "http://localhost:4200")
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "x-user-id,content-type");
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:4200");
      expect(res.headers["access-control-allow-headers"]).toMatch(/X-User-Id/i);
    });
  });

  describe("reading", () => {
    it("lists quotes filtered by status", async () => {
      const res = await request(h.app).get("/quotes?status=pending_specialist").set(as("S01"));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(9);
      const dupes = await request(h.app).get("/quotes?status=duplicate").set(as("S01"));
      expect(dupes.body.map((q: { draftId: string }) => q.draftId)).toEqual(["DQ-24110"]);
    });

    it("rejects an unknown status filter with 400", async () => {
      const res = await request(h.app).get("/quotes?status=bogus").set(as("S01"));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("validation_failed");
    });

    it("gets one quote, or 404", async () => {
      const ok = await request(h.app).get("/quotes/DQ-24106").set(as("U04"));
      expect(ok.body).toMatchObject({ draftId: "DQ-24106", approverPath: ["U02", "U04"], version: 1 });
      const missing = await request(h.app).get("/quotes/DQ-00000").set(as("U04"));
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("not_found");
    });
  });

  describe("specialist step", () => {
    it("approves a specialist-only quote straight to approved", async () => {
      const res = await approve("DQ-24101", "S02");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: QuoteStatus.Approved, version: 2 });
      expect(res.body.decisions).toEqual([
        { step: "specialist", decision: "approved", by: "S02", at: "2026-10-12T14:30:00.000Z", reason: null },
      ]);
    });

    it("forbids the specialist who prepared the quote (four eyes)", async () => {
      const res = await approve("DQ-24101", "S01");
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/prepared/);
    });

    it("forbids a manager from acting at the specialist step", async () => {
      expect((await approve("DQ-24102", "U01")).status).toBe(403);
    });
  });

  describe("approver step", () => {
    it("routes specialist -> manager -> approved, and audits every step", async () => {
      const step1 = await approve("DQ-24102", "S01");
      expect(step1.body.status).toBe(QuoteStatus.PendingApprover);

      expect((await approve("DQ-24102", "U04")).status).toBe(403); // not the routed approver
      expect((await approve("DQ-24102", "S03")).status).toBe(403); // specialists can't do step 2

      const step2 = await approve("DQ-24102", "U01");
      expect(step2.status).toBe(200);
      expect(step2.body).toMatchObject({ status: QuoteStatus.Approved, version: 3 });

      const audit = await request(h.app).get("/quotes/DQ-24102/audit").set(as("U01"));
      expect(
        audit.body.map((e: { actor: string; action: string; statusBefore: string | null; statusAfter: string }) => [
          e.actor,
          e.action,
          e.statusBefore,
          e.statusAfter,
        ]),
      ).toEqual([
        ["system", "quote_created", null, "pending_specialist"],
        ["S01", "specialist_approved", "pending_specialist", "pending_approver"],
        ["U01", "approver_approved", "pending_approver", "approved"],
      ]);
    });

    it("lets the backup approve when the regional manager is out of office", async () => {
      await approve("DQ-24106", "S01");
      expect((await approve("DQ-24106", "U02")).status).toBe(403); // out-of-office primary
      const res = await approve("DQ-24106", "U04");
      expect(res.body.status).toBe(QuoteStatus.Approved);
    });
  });

  describe("reject", () => {
    it("requires a reason", async () => {
      const res = await reject("DQ-24102", "S01", {});
      expect(res.status).toBe(400);
      expect(res.body.details.issues[0].path).toBe("reason");
    });

    it("rejects with a reason, audits it, and makes the quote terminal", async () => {
      const res = await reject("DQ-24102", "S01", { reason: "Customer asked for a different gasket" });
      expect(res.body.status).toBe(QuoteStatus.Rejected);

      const audit = await request(h.app).get("/quotes/DQ-24102/audit").set(as("S01"));
      expect(audit.body.at(-1)).toMatchObject({
        actor: "S01",
        action: "rejected",
        changes: { rejectionReason: { before: null, after: "Customer asked for a different gasket" } },
      });

      const again = await approve("DQ-24102", "S03");
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("invalid_transition");
    });

    it("lets the routed approver reject at step 2", async () => {
      await approve("DQ-24109", "S01");
      const res = await reject("DQ-24109", "U04", { reason: "Discount too deep for this account" });
      expect(res.body.status).toBe(QuoteStatus.Rejected);
    });
  });

  describe("conflicts", () => {
    it("returns 409 for a double approval from a stale screen (version precondition)", async () => {
      const first = await approve("DQ-24109", "S01", { version: 1 });
      expect(first.status).toBe(200);
      const second = await approve("DQ-24109", "S02", { version: 1 });
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ code: "conflict", details: { expectedVersion: 1, currentVersion: 2 } });
    });

    it("lets exactly one of two simultaneous approvals win; the other gets a conflict", async () => {
      const s01 = h.referenceData.getApprover("S01") as Approver;
      const s02 = h.referenceData.getApprover("S02") as Approver;
      const results = await Promise.allSettled([h.review.approve("DQ-24109", s01), h.review.approve("DQ-24109", s02)]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((r) => r.status === "rejected");
      expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(ConflictError);
      expect((await h.audit.history("DQ-24109")).filter((e) => e.action === "specialist_approved")).toHaveLength(1);
    });

    it("refuses to approve a duplicate (no second approval request)", async () => {
      const res = await approve("DQ-24110", "S01");
      expect(res.status).toBe(409);
      expect(res.body.details).toMatchObject({ status: "duplicate", action: "approve" });
    });
  });

  describe("intake and stubs", () => {
    it("processes drafts over HTTP idempotently", async () => {
      const fresh = await createHarness();
      const body = { drafts: fresh.drafts.slice(0, 2) };
      const first = await request(fresh.app).post("/drafts/process").set(as("S01")).send(body);
      expect(first.status).toBe(201);
      expect(first.body.results.map((r: { created: boolean }) => r.created)).toEqual([true, true]);

      const retry = await request(fresh.app).post("/drafts/process").set(as("S01")).send(body);
      expect(retry.status).toBe(200);
      expect(retry.body.results.map((r: { created: boolean }) => r.created)).toEqual([false, false]);
    });

    it("validates the drafts body", async () => {
      const res = await request(h.app).post("/drafts/process").set(as("S01")).send({ drafts: [{ draft_id: "X" }] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("validation_failed");
    });

    it("answers PATCH with 501 explaining that edits reprice and reroute", async () => {
      const res = await request(h.app).patch("/quotes/DQ-24102").set(as("S01")).send({ proposed_discount_pct: 10 });
      expect(res.status).toBe(501);
      expect(res.body.code).toBe("not_implemented");
      expect(res.body.details.design.join(" ")).toMatch(/pricing.*tier and approver/);
    });

    it("reports malformed JSON as a 400 in the standard shape", async () => {
      const res = await request(h.app)
        .post("/quotes/DQ-24102/reject")
        .set(as("S01"))
        .set("Content-Type", "application/json")
        .send("{not json");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: "validation_failed", message: "Malformed JSON body", details: {} });
    });
  });
});
