import type { Approver, ContractPrice, Customer, Product } from "../domain/models.js";
import type { ReferenceData } from "../ports/reference-data.port.js";

/** Raw tables a snapshot is built from. */
export interface ReferenceTables {
  exportedAt: Date;
  products: readonly Product[];
  customers: readonly Customer[];
  contractPrices: readonly ContractPrice[];
  approvers: readonly Approver[];
}

/**
 * Indexed, immutable in-memory {@link ReferenceData}. Shared by the CSV loader
 * and by tests, so tests can build small hand-made fixtures that behave exactly
 * like the real export.
 */
export class InMemoryReferenceData implements ReferenceData {
  readonly exportedAt: Date;
  private readonly products: ReadonlyMap<string, Product>;
  private readonly customers: ReadonlyMap<string, Customer>;
  private readonly contracts: ReadonlyMap<string, readonly ContractPrice[]>;
  private readonly approvers: ReadonlyMap<string, Approver>;

  constructor(tables: ReferenceTables) {
    this.exportedAt = new Date(tables.exportedAt.getTime());
    this.products = new Map(tables.products.map((p) => [p.part_number, p]));
    this.customers = new Map(tables.customers.map((c) => [c.customer_id, c]));
    this.approvers = new Map(tables.approvers.map((a) => [a.approver_id, a]));

    // Rows for one customer/part can be anywhere in the file (the sample export
    // has a C1007 row appended at the very end), so group by key, not position.
    const contracts = new Map<string, ContractPrice[]>();
    for (const row of tables.contractPrices) {
      const key = contractKey(row.customer_id, row.part_number);
      const bucket = contracts.get(key);
      if (bucket) bucket.push(row);
      else contracts.set(key, [row]);
    }
    this.contracts = contracts;
  }

  getProduct(partNumber: string): Product | undefined {
    return this.products.get(partNumber);
  }

  getCustomer(customerId: string): Customer | undefined {
    return this.customers.get(customerId);
  }

  getContractPrices(customerId: string, partNumber: string): readonly ContractPrice[] {
    return this.contracts.get(contractKey(customerId, partNumber)) ?? [];
  }

  getApprover(approverId: string): Approver | undefined {
    return this.approvers.get(approverId);
  }

  listApprovers(): readonly Approver[] {
    return [...this.approvers.values()];
  }
}

function contractKey(customerId: string, partNumber: string): string {
  return `${customerId}\u0000${partNumber}`;
}
