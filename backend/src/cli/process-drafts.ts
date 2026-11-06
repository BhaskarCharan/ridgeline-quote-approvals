import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDraftsFromFile } from "../adapters/json-draft-file.js";
import { loadEnv } from "../config/env.js";
import { createContainer } from "../container.js";

/**
 * Batch entry point: price, stock-check, route and persist the sample drafts,
 * then write `outputs/routing_results.json` (TASK.md Deliverable 1), one object
 * per draft in the order of `draft_quotes.json`.
 *
 * Usage: `npm run process -- [--reset] [path/to/draft_quotes.json]`
 * - default path: `$DATA_PACK_DIR/draft_quotes.json`
 * - `--reset`: wipe quotes and audit log first (demo only; refused in production).
 *
 * Re-running without --reset is safe: already-processed drafts are skipped
 * (idempotent per draftId) and their stored routing is written out again.
 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { reset: { type: "boolean", default: false } },
    allowPositionals: true,
  });

  const container = await createContainer(loadEnv());
  const { env, logger, processor } = container;
  try {
    if (values.reset) await container.resetStores();

    const draftsPath = path.resolve(positionals[0] ?? path.join(env.DATA_PACK_DIR, "draft_quotes.json"));
    const drafts = await loadDraftsFromFile(draftsPath);
    logger.info({ file: draftsPath, count: drafts.length }, "Processing drafts");

    const processed = await processor.processBatch(drafts);
    for (const { quote, created } of processed) {
      const r = quote.routing;
      logger.info(
        {
          draft: r.draft_id,
          created,
          workflow: quote.status,
          routing: r.status,
          net: r.net_total,
          discountPct: r.effective_discount_pct,
          approver: r.approver_id,
          flags: r.specialist_review_flags.length,
          duplicateOf: r.duplicate_of,
        },
        created ? "Routed" : "Already processed; unchanged",
      );
    }

    const results = processed.map(({ quote }) => quote.routing);
    await mkdir(path.dirname(env.ROUTING_RESULTS_PATH), { recursive: true });
    await writeFile(env.ROUTING_RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    logger.info(
      {
        file: env.ROUTING_RESULTS_PATH,
        count: results.length,
        created: processed.filter((p) => p.created).length,
      },
      "Wrote routing results",
    );
  } finally {
    await container.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
