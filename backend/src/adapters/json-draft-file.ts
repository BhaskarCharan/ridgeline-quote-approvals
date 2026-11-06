import { readFile } from "node:fs/promises";
import { parseDraftList } from "../domain/draft-schema.js";
import { ValidationError } from "../domain/errors.js";
import type { DraftQuote } from "../domain/models.js";

/** Read and validate `draft_quotes.json` (read-only), preserving file order. */
export async function loadDraftsFromFile(filePath: string): Promise<DraftQuote[]> {
  try {
    return parseDraftList(JSON.parse(await readFile(filePath, "utf8")));
  } catch (err: unknown) {
    if (err instanceof ValidationError) {
      throw new ValidationError("Invalid draft quotes file", { file: filePath, ...err.details });
    }
    throw err;
  }
}
