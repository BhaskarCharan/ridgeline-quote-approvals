import { describe, expect, it } from "vitest";
import type { DraftLine, DraftQuote } from "../src/domain/models.js";
import { DuplicateDetector } from "../src/services/duplicate-detector.js";

const line = (n: number, part: string, quantity: number, extra: Partial<DraftLine> = {}): DraftLine => ({
  line: n,
  part_number: part,
  description: `part ${part}`,
  quantity,
  unit: "EA",
  extraction_confidence: 0.97,
  ...extra,
});

const draft = (id: string, createdAt: string, lines: DraftLine[], overrides: Partial<DraftQuote> = {}): DraftQuote => ({
  draft_id: id,
  rfq_id: "RFQ-1",
  customer_id: "C1",
  created_at: createdAt,
  prepared_by: "S01",
  proposed_discount_pct: 10,
  lines,
  ...overrides,
});

const original = draft("D1", "2026-10-12T08:00:00-05:00", [line(1, "P1", 3), line(2, "P2", 5)]);

describe("DuplicateDetector (rule 11, 24h window)", () => {
  const detector = new DuplicateDetector(24);

  it("flags the same rfq_id and lines as a duplicate of the original", () => {
    const resubmit = draft("D2", "2026-10-12T09:15:00-05:00", [line(1, "P1", 3), line(2, "P2", 5)]);
    expect(detector.findOriginal(resubmit, [original])?.draft_id).toBe("D1");
  });

  it("ignores line order, line numbers, units, descriptions and confidence", () => {
    const reordered = draft("D2", "2026-10-12T09:15:00-05:00", [
      line(7, "P2", 5, { unit: "BX", description: "re-extracted", extraction_confidence: 0.6 }),
      line(9, "P1", 3),
    ]);
    expect(detector.findOriginal(reordered, [original])?.draft_id).toBe("D1");
  });

  it("is not a duplicate when a quantity differs", () => {
    const changed = draft("D2", "2026-10-12T09:15:00-05:00", [line(1, "P1", 4), line(2, "P2", 5)]);
    expect(detector.findOriginal(changed, [original])).toBeUndefined();
  });

  it("is not a duplicate when a line is added or removed", () => {
    const fewer = draft("D2", "2026-10-12T09:15:00-05:00", [line(1, "P1", 3)]);
    const more = draft("D3", "2026-10-12T09:15:00-05:00", [line(1, "P1", 3), line(2, "P2", 5), line(3, "P3", 1)]);
    expect(detector.findOriginal(fewer, [original])).toBeUndefined();
    expect(detector.findOriginal(more, [original])).toBeUndefined();
  });

  it("treats repeated parts as a multiset (P1x3 + P1x3 differs from P1x3)", () => {
    const base = draft("D1", "2026-10-12T08:00:00-05:00", [line(1, "P1", 3)]);
    const doubled = draft("D2", "2026-10-12T09:00:00-05:00", [line(1, "P1", 3), line(2, "P1", 3)]);
    expect(detector.findOriginal(doubled, [base])).toBeUndefined();
  });

  it("is not a duplicate for a different rfq_id with the same lines", () => {
    const otherRfq = draft("D2", "2026-10-12T09:15:00-05:00", original.lines, { rfq_id: "RFQ-2" });
    expect(detector.findOriginal(otherRfq, [original])).toBeUndefined();
  });

  it("respects the window: exactly 24h is in, just over is out", () => {
    const at24h = draft("D2", "2026-10-13T08:00:00-05:00", original.lines);
    const after24h = draft("D3", "2026-10-13T08:00:01-05:00", original.lines);
    expect(detector.findOriginal(at24h, [original])?.draft_id).toBe("D1");
    expect(detector.findOriginal(after24h, [original])).toBeUndefined();
  });

  it("uses the window from the policy, not a constant", () => {
    const resubmit = draft("D2", "2026-10-12T11:00:00-05:00", original.lines); // 3h later
    expect(new DuplicateDetector(2).findOriginal(resubmit, [original])).toBeUndefined();
    expect(new DuplicateDetector(4).findOriginal(resubmit, [original])?.draft_id).toBe("D1");
  });

  it("never matches a draft against itself or against a later draft", () => {
    const later = draft("D9", "2026-10-12T10:00:00-05:00", original.lines);
    expect(detector.findOriginal(original, [original, later])).toBeUndefined();
  });

  it("points a chain of resubmissions at the earliest original", () => {
    const second = draft("D2", "2026-10-12T09:00:00-05:00", original.lines);
    const third = draft("D3", "2026-10-12T10:00:00-05:00", original.lines);
    expect(detector.findOriginal(third, [original, second])?.draft_id).toBe("D1");
  });
});
