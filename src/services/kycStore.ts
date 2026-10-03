/**
 * Persistence layer for SEP-12 customers.
 *
 * The store is deliberately expressed as a tiny interface plus a Prisma-backed
 * implementation so the service can be exercised with an in-memory delegate in
 * tests (see `test/sep12Kyc.jest.test.ts`) without touching a database.
 */

import type { Sep12Fields, Sep12Status } from "./kycTypes";

/** A row of the `KycCustomer` table. */
export interface KycCustomerRow {
  id: string;
  account: string | null;
  memo: string | null;
  memoType: string | null;
  status: string;
  message: string | null;
  /** AES-256-GCM ciphertext of the JSON KYC field payload. */
  encryptedPayload: string;
  /** SEP-12 `fields` map, populated while status is NEEDS_INFO. */
  fieldsRequested: unknown;
  anchorReference: string | null;
  provider: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KycCustomerCreateData {
  id: string;
  account: string | null;
  memo: string | null;
  memoType: string | null;
  status: Sep12Status;
  message: string | null;
  encryptedPayload: string;
  fieldsRequested: Sep12Fields | null;
  anchorReference: string | null;
  provider: string | null;
}

export interface KycCustomerUpdateData {
  status: Sep12Status;
  message: string | null;
  encryptedPayload: string;
  fieldsRequested: Sep12Fields | null;
  anchorReference: string | null;
  provider: string | null;
}

export interface KycStore {
  findById(id: string): Promise<KycCustomerRow | null>;
  findByIdentity(
    account: string,
    memoType: string | null,
    memo: string | null,
  ): Promise<KycCustomerRow | null>;
  create(data: KycCustomerCreateData): Promise<KycCustomerRow>;
  update(id: string, data: KycCustomerUpdateData): Promise<KycCustomerRow>;
  delete(id: string): Promise<KycCustomerRow>;
}

/**
 * Structural shape of the Prisma delegate this store relies on. Using a local
 * interface keeps the store decoupled from the generated client and makes it
 * trivially fakeable in tests.
 */
export interface KycCustomerDelegate {
  findUnique(args: {
    where: Record<string, unknown>;
  }): Promise<KycCustomerRow | null>;
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
  }): Promise<KycCustomerRow | null>;
  create(args: { data: Record<string, unknown> }): Promise<KycCustomerRow>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<KycCustomerRow>;
  delete(args: { where: { id: string } }): Promise<KycCustomerRow>;
}

export interface KycDb {
  kycCustomer: KycCustomerDelegate;
}

export class PrismaKycStore implements KycStore {
  constructor(private readonly db: KycDb) {}

  async findById(id: string): Promise<KycCustomerRow | null> {
    return this.db.kycCustomer.findUnique({ where: { id } });
  }

  async findByIdentity(
    account: string,
    memoType: string | null,
    memo: string | null,
  ): Promise<KycCustomerRow | null> {
    return this.db.kycCustomer.findFirst({
      where: { account, memoType, memo },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(data: KycCustomerCreateData): Promise<KycCustomerRow> {
    return this.db.kycCustomer.create({
      data: { ...data } as unknown as Record<string, unknown>,
    });
  }

  async update(
    id: string,
    data: KycCustomerUpdateData,
  ): Promise<KycCustomerRow> {
    return this.db.kycCustomer.update({
      where: { id },
      data: { ...data } as unknown as Record<string, unknown>,
    });
  }

  async delete(id: string): Promise<KycCustomerRow> {
    return this.db.kycCustomer.delete({ where: { id } });
  }
}
