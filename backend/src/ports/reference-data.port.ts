import type { Approver, ContractPrice, Customer, Product } from "../domain/models.js";

/**
 * Read-only view of Ridgeline's nightly reporting export (products, customers,
 * contract prices, approvers). This is the *only* source of prices: the policy
 * forbids taking prices from anywhere else.
 *
 * Why synchronous: the export changes once a night and fits in memory (~40k
 * products), so adapters load a snapshot up front and services do plain
 * lookups with no I/O, no partial failures and no retries mid-pricing. A
 * production adapter would reload the snapshot after each nightly export.
 *
 * There are deliberately no write methods: this service must never write to
 * SAP or to the reporting data.
 */
export interface ReferenceData {
  /** When the export was produced; drives the 36h staleness rule. */
  readonly exportedAt: Date;

  getProduct(partNumber: string): Product | undefined;
  getCustomer(customerId: string): Customer | undefined;
  /** All contract rows for this customer and part, valid or not (may be empty). */
  getContractPrices(customerId: string, partNumber: string): readonly ContractPrice[];
  getApprover(approverId: string): Approver | undefined;
  listApprovers(): readonly Approver[];
}
