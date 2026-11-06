import { z } from "zod";
import { ValidationError } from "./errors.js";
import type { DraftQuote } from "./models.js";

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
 * Validates drafts from the extraction team, whether they arrive as a file
 * (CLI) or over HTTP (POST /drafts/process). Their output is AI-generated, so
 * it is untrusted input: shape errors are rejected here, while business doubts
 * (low confidence, unknown parts) become review flags later.
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

/** `{ drafts: [...] }`: the shape of draft_quotes.json and of the API body. */
export const DraftListSchema = z.object({ drafts: z.array(DraftQuoteSchema).min(1).max(500) });

/** Validate `{ drafts: [...] }`; throws ValidationError listing every problem. */
export function parseDraftList(input: unknown): DraftQuote[] {
  const result = DraftListSchema.safeParse(input);
  if (!result.success) {
    throw new ValidationError("Invalid drafts", {
      issues: result.error.issues.map((i) => ({ path: i.path.join("."), problem: i.message })),
    });
  }
  // Drop `note: undefined` so objects match DraftQuote under exactOptionalPropertyTypes.
  return result.data.drafts.map(({ note, ...d }) => (note === undefined ? d : { ...d, note }));
}
