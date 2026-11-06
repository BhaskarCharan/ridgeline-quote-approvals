import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { Decimal } from "decimal.js";
import { z } from "zod";
import { ROLES } from "../domain/enums.js";
import { ValidationError } from "../domain/errors.js";
import type { ReferenceData } from "../ports/reference-data.port.js";
import { InMemoryReferenceData } from "./in-memory-reference-data.js";

// --- Row schemas -----------------------------------------------------------
// Every row is validated so a malformed export fails loudly at startup instead
// of mispricing a quote later. Money is parsed straight from the CSV text into
// Decimal, never via a JS number.

const money = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal")
  .transform((s) => new Decimal(s));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const optionalIsoDate = z.union([z.literal(""), isoDate]).transform((s) => (s === "" ? null : s));
const optionalId = z.string().transform((s) => (s === "" ? null : s));
const id = z.string().min(1);

const ProductRow = z.object({
  part_number: id,
  description: z.string(),
  category: z.string(),
  unit: id,
  list_price: money,
  status: z.enum(["active", "discontinued"]),
  replaced_by: optionalId,
  primary_warehouse: z.string(),
});

const CustomerRow = z.object({
  customer_id: id,
  name: z.string(),
  region: id,
  pricing_tier: z.string(),
});

const ContractPriceRow = z
  .object({
    customer_id: id,
    part_number: id,
    contract_price: money,
    valid_from: isoDate,
    valid_to: isoDate,
  })
  .refine((r) => r.valid_from <= r.valid_to, { message: "valid_from is after valid_to" });

const ApproverRow = z.object({
  approver_id: id,
  name: z.string(),
  role: z.enum(ROLES),
  region: id,
  backup_approver_id: optionalId,
  out_of_office_from: optionalIsoDate,
  out_of_office_to: optionalIsoDate,
});

const ExportMetadata = z.object({
  exported_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 instant"),
});

/**
 * Load the nightly reporting export from a directory of CSVs
 * (`data-pack_platform/reporting_db`). Strictly read-only: files are only ever
 * opened with `readFile`, honouring the rule that we never write to the
 * reporting data.
 */
export async function loadCsvReferenceData(dir: string): Promise<ReferenceData> {
  const [products, customers, contractPrices, approvers, metadata] = await Promise.all([
    readCsv(dir, "products.csv", ProductRow),
    readCsv(dir, "customers.csv", CustomerRow),
    readCsv(dir, "contract_prices.csv", ContractPriceRow),
    readCsv(dir, "approvers.csv", ApproverRow),
    readJson(dir, "export_metadata.json", ExportMetadata),
  ]);

  return new InMemoryReferenceData({
    exportedAt: new Date(metadata.exported_at),
    products,
    customers,
    contractPrices,
    approvers,
  });
}

async function readCsv<S extends z.ZodType>(dir: string, file: string, schema: S): Promise<z.output<S>[]> {
  const filePath = path.join(dir, file);
  const records = parse(await readFile(filePath, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as unknown[];

  return records.map((record, index) => {
    const result = schema.safeParse(record);
    if (!result.success) {
      throw new ValidationError(`Invalid row in ${file}`, {
        file,
        row: index + 2, // +1 for the header, +1 for 1-based numbering
        issues: result.error.issues.map((i) => ({ field: i.path.join("."), problem: i.message })),
      });
    }
    return result.data;
  });
}

async function readJson<S extends z.ZodType>(dir: string, file: string, schema: S): Promise<z.output<S>> {
  const raw: unknown = JSON.parse(await readFile(path.join(dir, file), "utf8"));
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`Invalid ${file}`, {
      file,
      issues: result.error.issues.map((i) => ({ field: i.path.join("."), problem: i.message })),
    });
  }
  return result.data;
}
