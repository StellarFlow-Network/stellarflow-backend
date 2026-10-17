/**
 * Issue #1319 – Soroban Transaction Fee Envelope Builder & Gas Estimator API.
 *
 * Exercises the service and route with a mocked Soroban RPC server so the
 * envelope assembly and fee math are validated without network access.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import express from "express";
import type { Router } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import {
  Account,
  Contract,
  Keypair,
  Networks,
  SorobanDataBuilder,
  TransactionBuilder,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";

const simulateTransaction = jest.fn<(tx: unknown) => Promise<unknown>>();
const getFeeEstimate = jest.fn<() => Promise<Record<string, unknown>>>();

jest.unstable_mockModule("../src/lib/stellarProvider", () => ({
  default: {
    getRpcServer: () => ({ simulateTransaction }),
  },
}));

jest.unstable_mockModule("../src/services/feeEstimationService", () => ({
  feeEstimationService: { getFeeEstimate },
}));

let sorobanFeeEnvelopeService: typeof import("../src/services/sorobanFeeEnvelopeService").sorobanFeeEnvelopeService;
let SorobanFeeEnvelopeError: typeof import("../src/services/sorobanFeeEnvelopeService").SorobanFeeEnvelopeError;
let feeEnvelopeRouter: Router;

beforeAll(async () => {
  ({ sorobanFeeEnvelopeService, SorobanFeeEnvelopeError } =
    await import("../src/services/sorobanFeeEnvelopeService"));
  ({ default: feeEnvelopeRouter } =
    await import("../src/routes/sorobanFeeEnvelope"));
});

function contractId(byte: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, byte));
}

function footprint(id: string): xdr.LedgerKey[] {
  return [new Contract(id).getFootprint()];
}

function buildTransaction(): string {
  const source = Keypair.random();
  const account = new Account(source.publicKey(), "0");
  const contract = new Contract(contractId(7));

  return new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(contract.call("hello"))
    .setTimeout(30)
    .build()
    .toXDR();
}

function buildSimulation(minResourceFee = "12345"): unknown {
  const transactionData = new SorobanDataBuilder()
    .setResources(2_000_000, 4_096, 1_024)
    .setFootprint(footprint(contractId(7)), footprint(contractId(8)))
    .setResourceFee(BigInt(minResourceFee))
    .build();

  return {
    _parsed: true,
    id: "1",
    latestLedger: 987_654,
    events: [],
    minResourceFee,
    transactionData: new SorobanDataBuilder(transactionData),
    cost: { cpuInsns: "2000000", memBytes: "524288" },
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  };
}

beforeEach(() => {
  simulateTransaction.mockReset();
  getFeeEstimate.mockReset();
  getFeeEstimate.mockResolvedValue({
    baseFee: 100,
    low: 150,
    medium: 300,
    urgent: 900,
    networkCongestion: "low",
    lastLedgerCloseTime: new Date().toISOString(),
    ledgerCapacityUsedPercent: 10,
  });
  simulateTransaction.mockResolvedValue(buildSimulation());
});

describe("SorobanFeeEnvelopeService", () => {
  it("returns a ready-to-sign envelope with optimal fees", async () => {
    const result = await sorobanFeeEnvelopeService.buildEnvelope({
      transaction: buildTransaction(),
    });

    expect(result.status).toBe("success");
    expect(result.envelopeXdr).not.toBeNull();
    expect(result.transactionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.priority).toBe("medium");

    // Resource footprint is unpacked from the simulated Soroban data.
    expect(result.footprint).toMatchObject({
      instructions: "2000000",
      memoryBytes: "524288",
      readEntries: 2,
      writeEntries: 1,
      readBytes: "4096",
      writeBytes: "1024",
    });

    // BASE_FEE (100) + medium tip (300) + simulated resource fee (12345).
    expect(result.fees).toMatchObject({
      baseFeePerOperation: "100",
      inclusionFee: "400",
      priorityFee: "300",
      minResourceFee: "12345",
      resourceFeeBuffer: "0",
      resourceFee: "12345",
      totalFee: "12745",
    });
    expect(Number(result.fees.totalFeeXlm)).toBeCloseTo(0.0012745, 7);

    // The returned envelope must carry the computed total fee.
    const decoded = TransactionBuilder.fromXDR(
      result.envelopeXdr as string,
      Networks.TESTNET,
    );
    expect(decoded.fee).toBe("12745");
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(getFeeEstimate).toHaveBeenCalledTimes(1);
  });

  it("applies a resource fee buffer and requested priority tier", async () => {
    const result = await sorobanFeeEnvelopeService.buildEnvelope({
      transaction: buildTransaction(),
      priority: "urgent",
      resourceFeeBufferPercent: 10,
    });

    // BASE_FEE (100) + urgent tip (900) => inclusion 1000.
    expect(result.fees.priorityFee).toBe("900");
    expect(result.fees.inclusionFee).toBe("1000");
    // 10% of 12345 floored => 1234 buffer, resource fee 13579.
    expect(result.fees.resourceFeeBuffer).toBe("1234");
    expect(result.fees.resourceFee).toBe("13579");
    expect(result.fees.totalFee).toBe("14579");
  });

  it("reports restore_required without an envelope", async () => {
    const simulation = buildSimulation() as Record<string, unknown>;
    simulateTransaction.mockResolvedValue({
      ...simulation,
      restorePreamble: {
        minResourceFee: "777",
        transactionData: buildRestoreData(),
      },
    });

    const result = await sorobanFeeEnvelopeService.buildEnvelope({
      transaction: buildTransaction(),
    });

    expect(result.status).toBe("restore_required");
    expect(result.envelopeXdr).toBeNull();
    expect(result.transactionHash).toBeNull();
    expect(result.restorePreamble).toMatchObject({
      minResourceFee: "777",
    });
    expect(typeof result.restorePreamble?.transactionDataXdr).toBe("string");
  });

  it("rejects an invalid transaction envelope", async () => {
    await expect(
      sorobanFeeEnvelopeService.buildEnvelope({ transaction: "not-xdr" }),
    ).rejects.toBeInstanceOf(SorobanFeeEnvelopeError);
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it("surfaces simulation errors", async () => {
    simulateTransaction.mockResolvedValue({
      _parsed: true,
      id: "1",
      latestLedger: 5,
      events: [],
      error: "HostError: budget exceeded",
    });

    await expect(
      sorobanFeeEnvelopeService.buildEnvelope({
        transaction: buildTransaction(),
      }),
    ).rejects.toMatchObject({ code: "SIMULATION_FAILED", status: 422 });
  });

  it("validates the priority tier and buffer bounds", async () => {
    await expect(
      sorobanFeeEnvelopeService.buildEnvelope({
        transaction: buildTransaction(),
        priority: "turbo" as never,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    await expect(
      sorobanFeeEnvelopeService.buildEnvelope({
        transaction: buildTransaction(),
        resourceFeeBufferPercent: 250,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

function buildRestoreData(): SorobanDataBuilder {
  return new SorobanDataBuilder()
    .setResources(10, 10, 10)
    .setFootprint([], [])
    .setResourceFee(777n);
}

describe("POST /api/v1/soroban/fee-envelope", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/v1/soroban/fee-envelope", feeEnvelopeRouter);
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("builds a fee envelope through the route", async () => {
    const res = await fetch(`${baseUrl}/api/v1/soroban/fee-envelope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: buildTransaction() }),
    });
    const body = (await res.json()) as {
      success: boolean;
      data: { envelopeXdr: string; fees: { totalFee: string } };
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.envelopeXdr).toBeTruthy();
    expect(body.data.fees.totalFee).toBe("12745");
  });

  it("rejects a missing transaction", async () => {
    const res = await fetch(`${baseUrl}/api/v1/soroban/fee-envelope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it("rejects an unknown priority tier", async () => {
    const res = await fetch(`${baseUrl}/api/v1/soroban/fee-envelope`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        transaction: buildTransaction(),
        priority: "turbo",
      }),
    });

    expect(res.status).toBe(400);
  });
});
