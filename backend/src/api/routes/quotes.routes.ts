import { Router } from "express";
import { z } from "zod";
import { QUOTE_STATUSES } from "../../domain/enums.js";
import { NotImplementedError } from "../../domain/errors.js";
import type { QuoteReviewService } from "../../services/review.service.js";
import { currentUser } from "../middleware/auth.js";
import { parseInput } from "../validation.js";

const ListQuery = z.object({
  status: z.enum(QUOTE_STATUSES).optional(),
  approverId: z.string().min(1).optional(),
});

const ApproveBody = z
  .object({
    version: z.number().int().positive().optional(),
    comment: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

const RejectBody = z
  .object({
    reason: z.string().trim().min(1, "a rejection reason is required").max(1000),
    version: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Review endpoints. Thin by design: parse input, call the review service,
 * return JSON. All rules (who may act, which transitions exist, conflicts)
 * live in the service and the WORKFLOW table, so they are tested without HTTP.
 */
export function quotesRouter(review: QuoteReviewService): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const query = parseInput(ListQuery, req.query, "query");
    const filter = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.approverId ? { approverId: query.approverId } : {}),
    };
    res.json(await review.list(filter));
  });

  router.get("/:id", async (req, res) => {
    res.json(await review.get(req.params.id));
  });

  router.get("/:id/audit", async (req, res) => {
    res.json(await review.history(req.params.id));
  });

  router.post("/:id/approve", async (req, res) => {
    const body = parseInput(ApproveBody, req.body ?? {}, "body");
    const quote = await review.approve(req.params.id, currentUser(res), {
      ...(body.version !== undefined ? { expectedVersion: body.version } : {}),
      ...(body.comment !== undefined ? { reason: body.comment } : {}),
    });
    res.json(quote);
  });

  router.post("/:id/reject", async (req, res) => {
    const body = parseInput(RejectBody, req.body ?? {}, "body");
    const quote = await review.reject(req.params.id, currentUser(res), {
      reason: body.reason,
      ...(body.version !== undefined ? { expectedVersion: body.version } : {}),
    });
    res.json(quote);
  });

  /**
   * Stub: editing a quote. Deliberately not built; the 501 explains what the
   * production version does so API clients (and reviewers) see the design.
   */
  router.patch("/:id", async (req) => {
    throw new NotImplementedError("Editing quotes is not implemented in this version", {
      quoteId: req.params.id,
      design: [
        "Accept line edits (part, quantity) and a new proposed discount, with the version the editor saw (409 if stale).",
        "Re-run the full pipeline on the edited draft: contract/list pricing, stock check, review checks, tier and approver.",
        "Store the result as a new revision and reset the workflow to pending_specialist; earlier sign-offs no longer count.",
        "Audit action 'edited' with before/after for every changed field, plus the old and new routing.",
      ],
    });
  });

  return router;
}
