import type { Decimal } from "decimal.js";
import type { QuoteStatus, Role, RoutingOutcome } from "./enums.js";

// ---------------------------------------------------------------------------
// Inputs: shapes of the read-only data we receive. Field names mirror the
// source files (snake_case) so parsing is a straight mapping and nothing is
// silently renamed between the extraction team's JSON and our audit trail.
// ---------------------------------------------------------------------------

/** One line of a draft quote produced by the extraction team. */
export interface DraftLine {
  line: number;
  part_number: string;
  description: string;
  quantity: number;
  unit: string;
  /** 0..1. Below the policy threshold the line must go to a specialist first. */
  extraction_confidence: number;
}

/** A draft quote as delivered by the extraction team (`draft_quotes.json`). */
export interface DraftQuote {
  draft_id: string;
  rfq_id: string;
  customer_id: string;
  /** ISO 8601 with offset; used for the 24h duplicate window. */
  created_at: string;
  prepared_by: string;
  /** Percent (8 means 8%), applied on top of contract or list price. */
  proposed_discount_pct: number;
  lines: DraftLine[];
  note?: string;
}

/** Product row from the nightly reporting export. */
export interface Product {
  part_number: string;
  description: string;
  category: string;
  unit: string;
  list_price: Decimal;
  status: "active" | "discontinued";
  replaced_by: string | null;
  primary_warehouse: string;
}

/** Customer row from the nightly reporting export. Region drives manager routing. */
export interface Customer {
  customer_id: string;
  name: string;
  region: string;
  pricing_tier: string;
}

/** Contract price row. Validity is inclusive on both ends, in Central dates. */
export interface ContractPrice {
  customer_id: string;
  part_number: string;
  contract_price: Decimal;
  /** YYYY-MM-DD */
  valid_from: string;
  /** YYYY-MM-DD */
  valid_to: string;
}

/** Approver row. Out-of-office dates are inclusive, YYYY-MM-DD, or null. */
export interface Approver {
  approver_id: string;
  name: string;
  role: Role;
  /** A region name, or "ALL". */
  region: string;
  backup_approver_id: string | null;
  out_of_office_from: string | null;
  out_of_office_to: string | null;
}

/** Metadata about the reporting export, used for the 36h staleness rule. */
export interface ReportingExportMetadata {
  exported_at: string;
}

/** A single part's stock snapshot from the stock API. */
export interface StockReading {
  part_number: string;
  /** Warehouse code -> units on hand. */
  warehouses: Record<string, number>;
  /** When the reading was taken (may be stale). */
  as_of: string;
}

// ---------------------------------------------------------------------------
// Outputs of pricing / routing.
// ---------------------------------------------------------------------------

/** Where a line's unit price came from; explains every price to the reviewer. */
export type PriceSource = "contract" | "list";

/**
 * A reason a specialist must look at the quote before it is routed.
 * `line` is null when the issue concerns the whole quote (e.g. stock API down).
 */
export interface ReviewFlag {
  line: number | null;
  reason: string;
}

/** A draft line after pricing. Money stays as Decimal until serialisation. */
export interface PricedLine {
  kind: "priced";
  line: number;
  part_number: string;
  quantity: number;
  price_source: PriceSource;
  list_unit_price: Decimal;
  /** Contract or list unit price, before the proposed discount. */
  base_unit_price: Decimal;
  /** quantity x list price, rounded half-up to cents. */
  list_total: Decimal;
  /** quantity x base price x (1 - discount), rounded half-up to cents. */
  net_total: Decimal;
}

/**
 * A line that could not be priced (part not in the reporting data). Kept on the
 * quote rather than dropped, so the specialist sees it and decides; a price is
 * never invented.
 */
export interface UnpricedLine {
  kind: "unpriced";
  line: number;
  part_number: string;
  quantity: number;
  reason: string;
}

/** Outcome of pricing one draft line. */
export type LinePricing = PricedLine | UnpricedLine;

/**
 * Result of pricing a whole draft (approval_rules.md rules 3-6). Totals cover
 * priced lines only; unpriced lines are always flagged.
 */
export interface QuotePricing {
  lines: LinePricing[];
  /** Sum of rounded line totals at list price. */
  list_total: Decimal;
  /** Sum of rounded line net totals (contract/list price, then proposed discount). */
  net_total: Decimal;
  /**
   * Percent, unrounded: (1 - net/list) x 100. Kept at full precision so
   * thresholds compare exactly; round only when presenting. Null when nothing
   * could be priced (no list total to compare against).
   */
  effective_discount_pct: Decimal | null;
  specialist_review_flags: ReviewFlag[];
}

/** The persisted quote: the draft plus everything we derived from it. */
export interface Quote {
  draft_id: string;
  rfq_id: string;
  customer_id: string;
  status: QuoteStatus;
  routing_outcome: RoutingOutcome;
  lines: LinePricing[];
  net_total: Decimal;
  list_total: Decimal;
  /** Percent, e.g. 17.5 for 17.5%. Null when no line could be priced. */
  effective_discount_pct: Decimal | null;
  specialist_id: string;
  /** Second approver after backups are applied; null when specialist-only. */
  approver_id: string | null;
  specialist_review_flags: ReviewFlag[];
  duplicate_of: string | null;
  /** Optimistic-concurrency version; guards against double approvals. */
  version: number;
  created_at: string;
  updated_at: string;
}

/** One line of `outputs/routing_results.json` (Deliverable 1). Plain numbers. */
export interface RoutingResult {
  draft_id: string;
  status: RoutingOutcome;
  net_total: number | null;
  effective_discount_pct: number | null;
  approver_id: string | null;
  specialist_review_flags: ReviewFlag[];
  duplicate_of: string | null;
}

/** Append-only audit record: who did what, when, and the state before/after. */
export interface AuditEntry {
  at: string;
  actor_id: string;
  action: string;
  draft_id: string;
  status_before: QuoteStatus | null;
  status_after: QuoteStatus | null;
  /** Field-level before/after for edits; free-form context otherwise. */
  details: Record<string, unknown>;
}
