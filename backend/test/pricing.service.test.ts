import { readFile } from "node:fs/promises";
import path from "node:path";
import { Decimal } from "decimal.js";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../src/adapters/clock/fixed-clock.js";
import { loadCsvReferenceData } from "../src/adapters/csv-reference-data.js";
import { InMemoryReferenceData } from "../src/adapters/in-memory-reference-data.js";
import { REPO_ROOT } from "../src/config/env.js";
import type { DraftQuote, PricedLine } from "../src/domain/models.js";
import type { ReferenceData } from "../src/ports/reference-data.port.js";
import { PricingService } from "../src/services/pricing.service.js";

const POLICY_NOW = new FixedClock("2026-10-12T09:30:00-05:00");
const TZ = { timeZone: "America/Chicago" };

const pct2 = (d: Decimal | null): string | null => (d ? d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null);

describe("PricingService against the sample reporting export", () => {
  let referenceData: ReferenceData;
  let drafts: Map<string, DraftQuote>;
  let pricing: PricingService;

  beforeAll(async () => {
    referenceData = await loadCsvReferenceData(path.join(REPO_ROOT, "data-pack_platform/reporting_db"));
    const raw = JSON.parse(await readFile(path.join(REPO_ROOT, "data-pack_platform/draft_quotes.json"), "utf8")) as {
      drafts: DraftQuote[];
    };
    drafts = new Map(raw.drafts.map((d) => [d.draft_id, d]));
    pricing = new PricingService(referenceData, POLICY_NOW, TZ);
  });

  const draft = (id: string): DraftQuote => {
    const d = drafts.get(id);
    if (!d) throw new Error(`fixture ${id} missing`);
    return d;
  };

  it("uses list prices and the proposed discount when there is no contract (DQ-24101)", () => {
    const result = pricing.price(draft("DQ-24101"));
    expect(result.lines.every((l) => l.kind === "priced" && l.price_source === "list")).toBe(true);
    expect(result.list_total.toFixed(2)).toBe("473.08");
    expect(result.net_total.toFixed(2)).toBe("435.23");
    expect(pct2(result.effective_discount_pct)).toBe("8.00");
    expect(result.specialist_review_flags).toEqual([]);
  });

  it("stacks the discount on contract prices, pushing 22% proposed past 25% effective (DQ-24103)", () => {
    const result = pricing.price(draft("DQ-24103"));
    const line1 = result.lines[0] as PricedLine;
    // The C1007/RL178907 contract row is the second-to-last row of the CSV.
    expect(line1.price_source).toBe("contract");
    expect(line1.base_unit_price.toFixed(2)).toBe("9.53");
    expect(result.list_total.toFixed(2)).toBe("987.82");
    expect(result.net_total.toFixed(2)).toBe("728.80");
    expect(pct2(result.effective_discount_pct)).toBe("26.22");
  });

  it("falls back to list price and flags an expired contract (DQ-24107 line 1)", () => {
    const result = pricing.price(draft("DQ-24107"));
    const line1 = result.lines[0] as PricedLine;
    expect(line1.price_source).toBe("list");
    expect(line1.base_unit_price.toFixed(2)).toBe("8.40");
    expect(result.specialist_review_flags).toEqual([
      { line: 1, reason: "contract price expired 2025-12-31; list price used" },
    ]);
    expect(result.net_total.toFixed(2)).toBe("456.54");
    expect(pct2(result.effective_discount_pct)).toBe("15.38");
  });

  it("rounds each line half-up to cents before summing (DQ-24109)", () => {
    const result = pricing.price(draft("DQ-24109"));
    const line2 = result.lines[1] as PricedLine; // 10 x 22.14 x 0.84 = 185.976
    expect(line2.net_total.toFixed(2)).toBe("185.98");
    expect(result.net_total.toFixed(2)).toBe("1409.86");
    expect(pct2(result.effective_discount_pct)).toBe("18.36");
  });

  it("prices the high-value quote at list (DQ-24106: $47,652 at 5%)", () => {
    const result = pricing.price(draft("DQ-24106"));
    expect(result.net_total.toFixed(2)).toBe("47652.00");
    expect(pct2(result.effective_discount_pct)).toBe("5.00");
  });
});

describe("PricingService edge cases", () => {
  const refData = new InMemoryReferenceData({
    exportedAt: new Date("2026-10-11T07:00:00Z"),
    products: [
      {
        part_number: "P1",
        description: "Widget",
        category: "Test",
        unit: "EA",
        list_price: new Decimal("10.00"),
        status: "active",
        replaced_by: null,
        primary_warehouse: "DAL",
      },
      {
        part_number: "OLD",
        description: "Old widget",
        category: "Test",
        unit: "EA",
        list_price: new Decimal("5.00"),
        status: "discontinued",
        replaced_by: "P1",
        primary_warehouse: "DAL",
      },
    ],
    customers: [{ customer_id: "C1", name: "Acme", region: "Central", pricing_tier: "contract" }],
    contractPrices: [
      { customer_id: "C1", part_number: "P1", contract_price: new Decimal("8.00"), valid_from: "2026-10-12", valid_to: "2026-10-12" },
    ],
    approvers: [],
  });
  const pricing = new PricingService(refData, POLICY_NOW, TZ);

  const makeDraft = (overrides: Partial<DraftQuote>): DraftQuote => ({
    draft_id: "D1",
    rfq_id: "R1",
    customer_id: "C1",
    created_at: "2026-10-12T09:00:00-05:00",
    prepared_by: "S01",
    proposed_discount_pct: 0,
    lines: [{ line: 1, part_number: "P1", description: "Widget", quantity: 1, unit: "EA", extraction_confidence: 0.99 }],
    ...overrides,
  });

  it("flags an unknown part, leaves it unpriced and still prices the rest", () => {
    const result = pricing.price(
      makeDraft({
        lines: [
          { line: 1, part_number: "P1", description: "", quantity: 2, unit: "EA", extraction_confidence: 0.99 },
          { line: 2, part_number: "NOPE", description: "", quantity: 1, unit: "EA", extraction_confidence: 0.99 },
        ],
      }),
    );
    expect(result.lines[1]?.kind).toBe("unpriced");
    expect(result.net_total.toFixed(2)).toBe("16.00");
    expect(result.specialist_review_flags).toEqual([
      { line: 2, reason: "part NOPE not found in reporting data; line not priced" },
    ]);
  });

  it("flags an unknown customer and uses list prices instead of throwing", () => {
    const result = pricing.price(makeDraft({ customer_id: "GHOST" }));
    expect((result.lines[0] as PricedLine).price_source).toBe("list");
    expect(result.net_total.toFixed(2)).toBe("10.00");
    expect(result.specialist_review_flags).toEqual([
      { line: null, reason: "customer GHOST not found in reporting data; list prices used" },
    ]);
  });

  it("treats contract validity as inclusive, in Central time (late evening is still 'today')", () => {
    // 23:30 Central on Oct 12 is already Oct 13 in UTC.
    const lateEvening = new PricingService(refData, new FixedClock("2026-10-12T23:30:00-05:00"), TZ);
    expect((lateEvening.price(makeDraft({})).lines[0] as PricedLine).price_source).toBe("contract");
  });

  it("returns a null effective discount when nothing could be priced", () => {
    const result = pricing.price(
      makeDraft({ lines: [{ line: 1, part_number: "NOPE", description: "", quantity: 1, unit: "EA", extraction_confidence: 1 }] }),
    );
    expect(result.effective_discount_pct).toBeNull();
  });

  it("flags discontinued parts and unit mismatches but still prices them", () => {
    const result = pricing.price(
      makeDraft({ lines: [{ line: 1, part_number: "OLD", description: "", quantity: 1, unit: "BX", extraction_confidence: 1 }] }),
    );
    expect(result.lines[0]?.kind).toBe("priced");
    expect(result.specialist_review_flags.map((f) => f.reason)).toEqual([
      "part OLD is discontinued; replaced by P1",
      "draft unit BX differs from catalogue unit EA",
    ]);
  });
});
