/**
 * SEP-12 Customer Information Transfer (KYC) – Issue #990
 *
 * Covers the customer service directly (with an in-memory Prisma delegate and
 * the real AES-256-GCM encryption helper) and the HTTP surface through
 * supertest.
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeAll,
} from "@jest/globals";
import express from "express";
import request from "supertest";

// The application-wide service singleton pulls in the shared Prisma client;
// replace it so importing the router has no database side effects. The tests
// inject their own service through `createKycRouter`.
jest.mock("../src/services/kyc", () => ({
  __esModule: true,
  kycService: {},
}));

import { createKycRouter } from "../src/routes/kyc";
import { KycService } from "../src/services/kycService";
import { PrismaKycStore, type KycCustomerRow, type KycDb } from "../src/services/kycStore";
import { KycEncryptionService } from "../src/services/kycEncryption";
import {
  KycAnchorClient,
  type AnchorDecision,
  type AnchorSubmission,
  type KycAnchorForwarder,
} from "../src/services/kycAnchorClient";
import {
  SEP12_STATUS,
  Sep12NotFoundError,
  Sep12TransitionError,
  Sep12ValidationError,
} from "../src/services/kycTypes";

const KEY = "jest-kyc-master-key";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function account(seed: string): string {
  let value = seed;
  while (value.length < 55) value += B32;
  return `G${value.slice(0, 55)}`;
}

const ACCOUNT = account("A");
const OTHER_ACCOUNT = account("B");

const COMPLETE_FIELDS = {
  first_name: "Ada",
  last_name: "Lovelace",
  email_address: "ada@example.com",
  id_type: "passport",
  id_number: "X1234567",
};

function createDb(): { rows: Map<string, KycCustomerRow>; db: KycDb } {
  const rows = new Map<string, KycCustomerRow>();
  const clone = (row: KycCustomerRow): KycCustomerRow => ({ ...row });

  const db = {
    kycCustomer: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        const row = rows.get(String(where.id));
        return row ? clone(row) : null;
      },
      async findFirst({ where }: { where: Record<string, unknown> }) {
        for (const row of rows.values()) {
          if (
            row.account === where.account &&
            row.memoType === (where.memoType ?? null) &&
            row.memo === (where.memo ?? null)
          ) {
            return clone(row);
          }
        }
        return null;
      },
      async create({ data }: { data: Record<string, unknown> }) {
        const now = new Date();
        const row = { createdAt: now, updatedAt: now, ...data } as unknown as KycCustomerRow;
        rows.set(row.id, row);
        return clone(row);
      },
      async update({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) {
        const current = rows.get(String(where.id));
        if (!current) throw new Error("row not found");
        const row = { ...current, ...data, updatedAt: new Date() };
        rows.set(row.id, row);
        return clone(row);
      },
      async delete({ where }: { where: { id: string } }) {
        const current = rows.get(where.id);
        if (!current) throw new Error("row not found");
        rows.delete(where.id);
        return clone(current);
      },
    },
  } as unknown as KycDb;

  return { rows, db };
}

class FakeAnchor implements KycAnchorForwarder {
  public calls: AnchorSubmission[] = [];

  constructor(public decision: AnchorDecision) {}

  isConfigured(): boolean {
    return true;
  }

  async submit(submission: AnchorSubmission): Promise<AnchorDecision> {
    this.calls.push(submission);
    return this.decision;
  }
}

function build(decision?: AnchorDecision) {
  const { rows, db } = createDb();
  const store = new PrismaKycStore(db);
  const encryption = new KycEncryptionService(KEY);
  const anchor = new FakeAnchor(
    decision ?? { status: SEP12_STATUS.ACCEPTED, provider: "anchor" },
  );
  const service = new KycService({ store, encryption, anchor });
  return { rows, store, encryption, anchor, service };
}

describe("KycService (SEP-12)", () => {
  beforeAll(() => {
    process.env.KYC_ENCRYPTION_KEY = KEY;
  });

  it("creates a customer, encrypts the payload at rest, and round-trips", async () => {
    const { rows, encryption, service } = build();

    const result = await service.putCustomer({ account: ACCOUNT, ...COMPLETE_FIELDS });
    expect(result.id).toBeTruthy();
    expect(result.status).toBe(SEP12_STATUS.ACCEPTED);

    const row = rows.get(result.id)!;
    expect(row.encryptedPayload).not.toBe(JSON.stringify(COMPLETE_FIELDS));
    expect(row.encryptedPayload).not.toContain("ada@example.com");
    expect(encryption.decryptPayload(row.encryptedPayload)).toEqual(COMPLETE_FIELDS);
  });

  it("returns NEEDS_INFO with the missing field specs and does not call the anchor", async () => {
    const { service, anchor } = build();

    const result = await service.putCustomer({ account: ACCOUNT, first_name: "Ada" });

    expect(result.status).toBe(SEP12_STATUS.NEEDS_INFO);
    expect(result.fields).toBeDefined();
    expect(Object.keys(result.fields ?? {})).toEqual(
      expect.arrayContaining(["last_name", "email_address", "id_type", "id_number"]),
    );
    expect(anchor.calls).toHaveLength(0);
  });

  it("looks a customer up by account, by account + memo, and by id", async () => {
    const { service } = build();
    const created = await service.putCustomer({ account: ACCOUNT, ...COMPLETE_FIELDS });

    const byAccount = await service.getCustomer({
      id: undefined,
      account: ACCOUNT,
      memo: undefined,
      memoType: undefined,
    });
    expect(byAccount?.id).toBe(created.id);
    expect(byAccount?.first_name).toBe("Ada");

    const withMemo = await service.putCustomer({
      account: OTHER_ACCOUNT,
      memo: "42",
      memo_type: "id",
      ...COMPLETE_FIELDS,
    });
    const memoLookup = await service.getCustomer({
      id: undefined,
      account: OTHER_ACCOUNT,
      memo: "42",
      memoType: "id",
    });
    expect(memoLookup?.id).toBe(withMemo.id);

    const byId = await service.getCustomer({
      id: created.id,
      account: undefined,
      memo: undefined,
      memoType: undefined,
    });
    expect(byId?.id).toBe(created.id);
  });

  it("updates an existing customer without creating a duplicate", async () => {
    const { rows, service } = build();
    const created = await service.putCustomer({ account: ACCOUNT, ...COMPLETE_FIELDS });

    const updated = await service.putCustomer({
      account: ACCOUNT,
      address: "12 Analytical Engine Way",
    });

    expect(updated.id).toBe(created.id);
    expect(rows.size).toBe(1);

    const fetched = await service.getCustomer({
      id: created.id,
      account: undefined,
      memo: undefined,
      memoType: undefined,
    });
    expect(fetched?.address).toBe("12 Analytical Engine Way");
    expect(fetched?.first_name).toBe("Ada");
  });

  it("deletes a customer and reports a missing customer on repeat", async () => {
    const { service } = build();
    const created = await service.putCustomer({ account: ACCOUNT, ...COMPLETE_FIELDS });

    await expect(service.deleteCustomer(created.id)).resolves.toBe(true);
    await expect(
      service.getCustomer({
        id: created.id,
        account: undefined,
        memo: undefined,
        memoType: undefined,
      }),
    ).resolves.toBeNull();
    await expect(service.deleteCustomer(created.id)).resolves.toBe(false);
  });

  it("applies legal status transitions and rejects illegal ones", async () => {
    const { service } = build({ status: SEP12_STATUS.PROCESSING, provider: "anchor" });
    const created = await service.putCustomer({ account: ACCOUNT, ...COMPLETE_FIELDS });
    expect(created.status).toBe(SEP12_STATUS.PROCESSING);

    const rejected = await service.updateStatus(
      created.id,
      SEP12_STATUS.REJECTED,
      "document unreadable",
    );
    expect(rejected?.status).toBe(SEP12_STATUS.REJECTED);

    await expect(
      service.updateStatus(created.id, SEP12_STATUS.PROCESSING),
    ).rejects.toBeInstanceOf(Sep12TransitionError);
  });

  it("does not regress a terminal ACCEPTED status on a later update", async () => {
    const { rows, service, anchor } = build();
    const created = await service.putCustomer({ account: ACCOUNT, ...COMPLETE_FIELDS });
    expect(created.status).toBe(SEP12_STATUS.ACCEPTED);

    anchor.decision = { status: SEP12_STATUS.PROCESSING };

    const second = await service.putCustomer({ account: ACCOUNT, address: "x" });
    expect(second.status).toBe(SEP12_STATUS.ACCEPTED);
    expect(rows.get(created.id)?.status).toBe(SEP12_STATUS.ACCEPTED);
  });

  it("rejects invalid identities, memo usage, and unknown ids", async () => {
    const { service } = build();

    await expect(
      service.getCustomer({
        id: undefined,
        account: undefined,
        memo: undefined,
        memoType: undefined,
      }),
    ).rejects.toBeInstanceOf(Sep12ValidationError);

    await expect(service.putCustomer({ memo: "5" })).rejects.toBeInstanceOf(
      Sep12ValidationError,
    );

    await expect(
      service.putCustomer({ account: "not-a-stellar-account", ...COMPLETE_FIELDS }),
    ).rejects.toBeInstanceOf(Sep12ValidationError);

    await expect(
      service.getCustomer({
        id: undefined,
        account: ACCOUNT,
        memo: "abc",
        memoType: undefined,
      }),
    ).rejects.toBeInstanceOf(Sep12ValidationError);

    await expect(
      service.putCustomer({ id: "missing-id", ...COMPLETE_FIELDS }),
    ).rejects.toBeInstanceOf(Sep12NotFoundError);
  });

  it("forwards only the encrypted payload to the anchor", async () => {
    const { service, anchor } = build();

    await service.putCustomer({ account: ACCOUNT, ...COMPLETE_FIELDS });

    expect(anchor.calls).toHaveLength(1);
    const submission = anchor.calls[0]!;
    expect(submission.account).toBe(ACCOUNT);
    expect(submission.encryptedPayload).not.toContain("ada@example.com");
    expect([...submission.fields].sort()).toEqual(Object.keys(COMPLETE_FIELDS).sort());
  });

  it("is offline-safe when no anchor URL is configured", async () => {
    let fetched = false;
    const client = new KycAnchorClient(undefined, (async () => {
      fetched = true;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch);

    const decision = await client.submit({
      reference: "ref-1",
      account: ACCOUNT,
      memo: null,
      memoType: null,
      encryptedPayload: "deadbeef",
      fields: [],
    });

    expect(decision.status).toBe(SEP12_STATUS.PROCESSING);
    expect(fetched).toBe(false);
  });
});

describe("SEP-12 customer routes", () => {
  function app(service: KycService) {
    const instance = express();
    instance.use(express.json());
    instance.use("/api/v1/kyc", createKycRouter(service));
    return instance;
  }

  it("returns the SEP-12 customer envelope on PUT and GET", async () => {
    const { service } = build();
    const server = app(service);

    const put = await request(server)
      .put("/api/v1/kyc/customer")
      .send({ account: ACCOUNT, ...COMPLETE_FIELDS });

    expect(put.status).toBe(200);
    expect(put.body.id).toBeTruthy();
    expect(put.body.status).toBe(SEP12_STATUS.ACCEPTED);

    const get = await request(server)
      .get("/api/v1/kyc/customer")
      .query({ id: put.body.id });

    expect(get.status).toBe(200);
    expect(get.body.id).toBe(put.body.id);
    expect(get.body.first_name).toBe("Ada");
  });

  it("returns NEEDS_INFO fields for an incomplete customer", async () => {
    const { service } = build();
    const server = app(service);

    const res = await request(server)
      .put("/api/v1/kyc/customer")
      .send({ account: ACCOUNT, first_name: "Ada" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(SEP12_STATUS.NEEDS_INFO);
    expect(res.body.fields).toHaveProperty("id_number");
  });

  it("maps validation failures to the shared error envelope", async () => {
    const { service } = build();
    const server = app(service);

    const res = await request(server).get("/api/v1/kyc/customer");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for an unknown customer id", async () => {
    const { service } = build();
    const server = app(service);

    const res = await request(server)
      .get("/api/v1/kyc/customer")
      .query({ id: "nope" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("deletes a customer and then 404s", async () => {
    const { service } = build();
    const server = app(service);

    const put = await request(server)
      .put("/api/v1/kyc/customer")
      .send({ account: ACCOUNT, ...COMPLETE_FIELDS });

    const del = await request(server).delete(`/api/v1/kyc/customer/${put.body.id}`);
    expect(del.status).toBe(200);

    const get = await request(server)
      .get("/api/v1/kyc/customer")
      .query({ id: put.body.id });
    expect(get.status).toBe(404);
  });

  it("returns 404 when creating against an unknown id", async () => {
    const { service } = build();
    const server = app(service);

    const res = await request(server)
      .put("/api/v1/kyc/customer")
      .send({ id: "unknown-id", ...COMPLETE_FIELDS });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
