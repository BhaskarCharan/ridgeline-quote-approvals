import { Router } from "express";
import { parseDraftList } from "../../domain/draft-schema.js";
import type { QuoteProcessor } from "../../services/quote-processor.js";

/**
 * Intake endpoint for the extraction team: `POST /drafts/process` with
 * `{ drafts: [...] }`. Runs the same pipeline as the CLI and is idempotent per
 * draft_id, so the extraction service can safely retry after a timeout.
 */
export function draftsRouter(processor: QuoteProcessor): Router {
  const router = Router();

  router.post("/process", async (req, res) => {
    const drafts = parseDraftList(req.body);
    const results = await processor.processBatch(drafts);
    res.status(results.some((r) => r.created) ? 201 : 200).json({
      results: results.map(({ quote, created }) => ({
        draftId: quote.draftId,
        created,
        status: quote.status,
        version: quote.version,
        routing: quote.routing,
      })),
    });
  });

  return router;
}
