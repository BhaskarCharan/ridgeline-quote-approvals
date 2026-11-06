import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ValidationError } from "../domain/errors.js";
import type { DraftQuote } from "../domain/models.js";

const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 instant");

const DraftLineSchema = z.object({
  line: z.number().int().positive(),
  part_number: z.string().min(1),
  description: z.string(),
  quantity: z.number().positive(),
  unit: z.string().min(1),
  extraction_confidence: z.number().min(0).max(1),
});

/**
 * Validates drafts from the extraction team. Their output is AI-generated, so
 * it is treated as untrusted input: shape errors are rejected here, while
 * business doubts (low confidence, unknown parts) become review flags later.
 */
export const DraftQuoteSchema = z.object({
  draft_id: z.string().min(1),
  rfq_id: z.string().min(1),
  customer_id: z.string().min(1),
  created_at: isoInstant,
  prepared_by: z.string().min(1),
  proposed_discount_pct: z.number(),
  lines: z
    .array(DraftLineSchema)
    .min(1)
    .refine((lines) => new Set(lines.map((l) => l.line)).size === lines.length, "line numbers must be unique"),
  note: z.string().optional(),
});

const DraftFileSchema = z.object({ drafts: z.array(DraftQuoteSchema) });

/** Read `draft_quotes.json` (read-only), preserving file order. */
export async function loadDraftsFromFile(filePath: string): Promise<DraftQuote[]> {
  const result = DraftFileSchema.safeParse(JSON.parse(await readFile(filePath, "utf8")));
  if (!result.success) {
    throw new ValidationError("Invalid draft quotes file", {
      file: filePath,
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), problem: i.message })),
    });
  }
  // Strip `note: undefined` so the object matches DraftQuote under exactOptionalPropertyTypes.
  return result.data.drafts.map(({ note, ...d }) => (note === undefined ? d : { ...d, note }));
}
