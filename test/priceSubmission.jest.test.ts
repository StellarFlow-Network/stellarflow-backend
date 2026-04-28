/**
 * Integration test for price submission — Issue #233
 *
 * Runs a full "mock transaction" through StellarService.submitPriceUpdate()
 * without spending real XLM by replacing the Horizon server and signer with
 * in-memory stubs.
 */

import { jest } from "@jest/globals";

// ── Mock the signer so no real key is needed ──────────────────────────────────
const MOCK_PUBLIC_KEY =
  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const MOCK_SIGNATURE = Buffer.alloc(64, 0x01);

jest.mock("../src/signer/index.js", () => ({
  signer: {
    getPublicKey: jest.fn(async () => MOCK_PUBLIC_KEY),
    sign: jest.fn(async () => MOCK_SIGNATURE),
  },
}));

// ── Mock stellarProvider so no real Horizon call is made ──────────────────────
const MOCK_TX_HASH =
  "aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233";

const mockSubmitTransaction = jest.fn(async () => ({
  hash: MOCK_TX_HASH,
  successful: true,
}));

const mockLoadAccount = jest.fn(async (publicKey: string) => ({
  id: publicKey,
  sequence: "100",
  incrementSequenceNumber: jest.fn(),
}));

const mockFeeStats = jest.fn(async () => ({
  fee_charged: { p50: "100" },
}));

const mockHorizonServer = {
  loadAccount: mockLoadAccount,
  submitTransaction: mockSubmitTransaction,
  feeStats: mockFeeStats,
};

jest.mock("../src/lib/stellarProvider.js", () => ({
  default: {
    getServer: jest.fn(() => mockHorizonServer),
  },
}));

// ── Mock sequence manager to avoid DB dependency ─────────────────────────────
jest.mock("../src/services/sequence-manager.js", () => ({
  sequenceManager: {
    getNextSequence: jest.fn(async () => "100"),
    releaseSequence: jest.fn(async () => {}),
  },
}));

// ── Mock appState so lockdown is never active ─────────────────────────────────
jest.mock("../src/state/appState.js", () => ({
  assertSigningAllowed: jest.fn(async () => {}),
  isLockdownError: jest.fn(() => false),
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

import { StellarService } from "../src/services/stellarService.js";

describe("StellarService — price submission (mock Soroban)", () => {
  let service: StellarService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StellarService();
  });

  it("submitPriceUpdate returns a transaction hash", async () => {
    const hash = await service.submitPriceUpdate("USD-NGN", 1580.5, "memo-01");

    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  it("submitted transaction contains a manageData operation for the currency", async () => {
    await service.submitPriceUpdate("USD-NGN", 1580.5, "memo-02");

    const [tx] = mockSubmitTransaction.mock.calls[0] as any[];
    const ops = tx.operations as Array<{
      type: string;
      name: string;
      value: Buffer;
    }>;

    expect(ops.length).toBeGreaterThanOrEqual(1);
    const op = ops.find((o) => o.type === "manageData");
    expect(op).toBeDefined();
    expect(op!.name).toBe("USD-NGN_PRICE");
    expect(op!.value.toString()).toBe("1580.5");
  });

  it("submitted transaction carries the correct memo", async () => {
    await service.submitPriceUpdate("USD-NGN", 1580.5, "memo-03");

    const [tx] = mockSubmitTransaction.mock.calls[0] as any[];
    expect(tx.memo?.value?.toString()).toBe("memo-03");
  });

  it("does not call the real Horizon server", async () => {
    await service.submitPriceUpdate("USD-NGN", 1580.5, "memo-04");
    // mockHorizonServer.submitTransaction is our stub — real network never reached
    expect(mockSubmitTransaction).toHaveBeenCalled();
  });
});
