import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDraftsFromFile } from "../adapters/json-draft-file.js";
import { loadEnv } from "../config/env.js";
import { createContainer } from "../container.js";
import { toRoutingResult } from "../services/routing-result.mapper.js";

/**
 * Batch entry point: price, stock-check and route the sample drafts, then write
 * `outputs/routing_results.json` (TASK.md Deliverable 1), one object per draft
 * in the order of `draft_quotes.json`.
 *
 * Usage: `npm run process [path/to/draft_quotes.json]`
 * (defaults to `$DATA_PACK_DIR/draft_quotes.json`).
 */
async function main(): Promise<void> {
  const container = await createContainer(loadEnv());
  const { env, logger, processor } = container;
  try {
    const draftsPath = path.resolve(process.argv[2] ?? path.join(env.DATA_PACK_DIR, "draft_quotes.json"));
    const drafts = await loadDraftsFromFile(draftsPath);
    logger.info({ file: draftsPath, count: drafts.length }, "Processing drafts");

    const processed = await processor.processBatch(drafts);
    const results = processed.map(toRoutingResult);

    for (const r of results) {
      logger.info(
        {
          draft: r.draft_id,
          status: r.status,
          net: r.net_total,
          discountPct: r.effective_discount_pct,
          approver: r.approver_id,
          flags: r.specialist_review_flags.length,
          duplicateOf: r.duplicate_of,
        },
        "Routed",
      );
    }

    await mkdir(path.dirname(env.ROUTING_RESULTS_PATH), { recursive: true });
    await writeFile(env.ROUTING_RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    logger.info({ file: env.ROUTING_RESULTS_PATH, count: results.length }, "Wrote routing results");
  } finally {
    await container.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
