import { Decimal } from "decimal.js";
import { calendarDate } from "../domain/dates.js";
import type {
  ContractPrice,
  DraftLine,
  DraftQuote,
  LinePricing,
  PricedLine,
  QuotePricing,
  ReviewFlag,
} from "../domain/models.js";
import { roundCents, sum } from "../domain/money.js";
import type { Clock } from "../ports/clock.js";
import type { ReferenceData } from "../ports/reference-data.port.js";

/** Settings for {@link PricingService}. */
export interface PricingOptions {
  /** IANA zone whose calendar date decides contract validity (Ridgeline: America/Chicago). */
  timeZone: string;
}

/**
 * Prices a draft quote per approval_rules.md rules 3-6:
 * - rule 3: contract price if one is valid today, else list price;
 * - rule 4: an expired contract falls back to list price *and* flags the line;
 * - rule 5: the draft's proposed discount is applied on top of that price;
 * - rule 6: effective discount = 1 - (net total / total at list price).
 *
 * Why it never throws on bad references: an unknown part or customer is a
 * question for the quote specialist, not a reason to lose the quote. Problems
 * become `specialist_review_flags`, and a price is never guessed.
 */
export class PricingService {
  constructor(
    private readonly referenceData: ReferenceData,
    private readonly clock: Clock,
    private readonly options: PricingOptions,
  ) {}

  /** Price every line of `draft` as of the clock's date in the business time zone. */
  price(draft: DraftQuote): QuotePricing {
    const today = calendarDate(this.clock.now(), this.options.timeZone);
    const flags: ReviewFlag[] = [];

    const customer = this.referenceData.getCustomer(draft.customer_id);
    if (!customer) {
      flags.push({
        line: null,
        reason: `customer ${draft.customer_id} not found in reporting data; list prices used`,
      });
    }

    const pct = new Decimal(draft.proposed_discount_pct);
    if (pct.isNegative() || pct.greaterThan(100)) {
      flags.push({ line: null, reason: `proposed discount ${pct.toString()}% is outside 0-100%` });
    }
    const discountFactor = new Decimal(1).minus(pct.dividedBy(100));

    const lines = draft.lines.map((line) =>
      this.priceLine(line, customer ? draft.customer_id : null, today, discountFactor, flags),
    );

    const priced = lines.filter((l): l is PricedLine => l.kind === "priced");
    const listTotal = sum(priced.map((l) => l.list_total));
    const netTotal = sum(priced.map((l) => l.net_total));

    return {
      lines,
      list_total: listTotal,
      net_total: netTotal,
      effective_discount_pct: effectiveDiscountPct(netTotal, listTotal),
      specialist_review_flags: flags,
    };
  }

  private priceLine(
    line: DraftLine,
    customerId: string | null,
    today: string,
    discountFactor: Decimal,
    flags: ReviewFlag[],
  ): LinePricing {
    const product = this.referenceData.getProduct(line.part_number);
    if (!product) {
      const reason = `part ${line.part_number} not found in reporting data; line not priced`;
      flags.push({ line: line.line, reason });
      return { kind: "unpriced", line: line.line, part_number: line.part_number, quantity: line.quantity, reason };
    }

    if (product.status === "discontinued") {
      const replacement = product.replaced_by ? `; replaced by ${product.replaced_by}` : "";
      flags.push({ line: line.line, reason: `part ${product.part_number} is discontinued${replacement}` });
    }
    if (line.unit !== product.unit) {
      // A unit mismatch (e.g. EA vs BX of 100) would misprice by orders of magnitude.
      flags.push({
        line: line.line,
        reason: `draft unit ${line.unit} differs from catalogue unit ${product.unit}`,
      });
    }

    const contracts = customerId ? this.referenceData.getContractPrices(customerId, line.part_number) : [];
    const contract = pickValidContract(contracts, today);
    if (!contract) {
      const lastExpiry = latestExpiry(contracts, today);
      if (lastExpiry) {
        flags.push({ line: line.line, reason: `contract price expired ${lastExpiry}; list price used` });
      }
    }

    const quantity = new Decimal(line.quantity);
    const baseUnitPrice = contract ? contract.contract_price : product.list_price;

    return {
      kind: "priced",
      line: line.line,
      part_number: line.part_number,
      quantity: line.quantity,
      price_source: contract ? "contract" : "list",
      list_unit_price: product.list_price,
      base_unit_price: baseUnitPrice,
      list_total: roundCents(quantity.times(product.list_price)),
      net_total: roundCents(quantity.times(baseUnitPrice).times(discountFactor)),
    };
  }
}

/**
 * Contract valid today (inclusive both ends). If several overlap, the most
 * recently started one wins, as the latest negotiated terms; ties go to the
 * lower price so the customer is never overcharged by ambiguity.
 */
function pickValidContract(contracts: readonly ContractPrice[], today: string): ContractPrice | undefined {
  return contracts
    .filter((c) => c.valid_from <= today && today <= c.valid_to)
    .sort(
      (a, b) =>
        b.valid_from.localeCompare(a.valid_from) || a.contract_price.comparedTo(b.contract_price),
    )[0];
}

/** Latest `valid_to` among contracts that ended before today, if any (rule 4). */
function latestExpiry(contracts: readonly ContractPrice[], today: string): string | undefined {
  return contracts
    .map((c) => c.valid_to)
    .filter((validTo) => validTo < today)
    .sort()
    .at(-1);
}

/** Rule 6 as a percentage, unrounded. Null when there is no list total to compare against. */
function effectiveDiscountPct(netTotal: Decimal, listTotal: Decimal): Decimal | null {
  if (listTotal.isZero()) return null;
  return new Decimal(1).minus(netTotal.dividedBy(listTotal)).times(100);
}
