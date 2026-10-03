import { beforeAll, describe, expect, it, jest } from "@jest/globals";
import { AlertSeverity, AlertType } from "../src/services/notificationService";
import type {
  ContractReserveReader,
  DatabasePoolReserveRecord,
  PoolReserveStore,
} from "../src/services/ammReserveDivergenceDetector";

jest.unstable_mockModule("../src/lib/prisma", () => ({
  default: {},
  prisma: {},
}));

jest.unstable_mockModule("../src/lib/redis", () => ({
  getRedisClient: jest.fn(() => null),
}));

jest.unstable_mockModule("../src/lib/socket", () => ({
  broadcastToSessions: jest.fn(),
}));

jest.unstable_mockModule("../src/lib/stellarProvider", () => ({
  default: {
    getRpcServer: jest.fn(),
  },
}));

let AmmReserveDivergenceDetector: typeof import("../src/services/ammReserveDivergenceDetector").AmmReserveDivergenceDetector;

beforeAll(async () => {
  ({ AmmReserveDivergenceDetector } =
    await import("../src/services/ammReserveDivergenceDetector"));
});

const pool: DatabasePoolReserveRecord = {
  poolAddress: "CPOOLADDRESS",
  contractId: "CCONTRACTADDRESS",
  reserveA: "100",
  reserveB: "200",
  reserveAStorageKey: "reserve_a",
  reserveBStorageKey: "reserve_b",
};

function makeStore(pools: DatabasePoolReserveRecord[]): PoolReserveStore & {
  listTrackedPools: jest.MockedFunction<PoolReserveStore["listTrackedPools"]>;
  resyncPoolReserves: jest.MockedFunction<
    PoolReserveStore["resyncPoolReserves"]
  >;
} {
  return {
    listTrackedPools: jest.fn<PoolReserveStore["listTrackedPools"]>(() =>
      Promise.resolve(pools),
    ),
    resyncPoolReserves: jest.fn<PoolReserveStore["resyncPoolReserves"]>(() =>
      Promise.resolve(),
    ),
  };
}

function makeReader(
  reserves: Record<string, [bigint, bigint]>,
): ContractReserveReader & {
  getLatestLedgerSequence: jest.MockedFunction<
    ContractReserveReader["getLatestLedgerSequence"]
  >;
  getPoolReserves: jest.MockedFunction<
    ContractReserveReader["getPoolReserves"]
  >;
} {
  return {
    getLatestLedgerSequence: jest.fn<
      ContractReserveReader["getLatestLedgerSequence"]
    >(() => Promise.resolve(50)),
    getPoolReserves: jest.fn<ContractReserveReader["getPoolReserves"]>(
      (trackedPool, ledgerSeq) => {
        const [reserveA, reserveB] = reserves[trackedPool.poolAddress] ?? [
          BigInt(trackedPool.reserveA.toString()),
          BigInt(trackedPool.reserveB.toString()),
        ];
        return Promise.resolve({
          poolAddress: trackedPool.poolAddress,
          contractId: trackedPool.contractId,
          ledgerSeq,
          reserveA,
          reserveB,
          observedAt: "2026-09-29T00:00:00.000Z",
        });
      },
    ),
  };
}

describe("AmmReserveDivergenceDetector", () => {
  it("compares reserves only on the configured 50-ledger cadence", async () => {
    const store = makeStore([pool]);
    const reader = makeReader({ CPOOLADDRESS: [100n, 200n] });
    const notifications = { sendAlert: jest.fn(() => Promise.resolve(true)) };
    const detector = new AmmReserveDivergenceDetector(
      store,
      reader,
      notifications,
      { intervalLedgers: 50, pollIntervalMs: 1000 },
    );

    await expect(detector.onNewLedger(49)).resolves.toEqual([]);
    expect(store.listTrackedPools).not.toHaveBeenCalled();

    await detector.onNewLedger(50);
    expect(store.listTrackedPools).toHaveBeenCalledTimes(1);

    await detector.onNewLedger(99);
    expect(store.listTrackedPools).toHaveBeenCalledTimes(1);

    await detector.onNewLedger(100);
    expect(store.listTrackedPools).toHaveBeenCalledTimes(2);
  });

  it("raises a high-priority alarm when delta R is non-zero", async () => {
    const store = makeStore([pool]);
    const reader = makeReader({ CPOOLADDRESS: [101n, 200n] });
    const notifications = { sendAlert: jest.fn(() => Promise.resolve(true)) };
    const detector = new AmmReserveDivergenceDetector(
      store,
      reader,
      notifications,
      { intervalLedgers: 50, pollIntervalMs: 1000 },
    );

    const divergences = await detector.onNewLedger(50);

    expect(divergences).toHaveLength(1);
    expect(divergences[0]).toMatchObject({
      poolAddress: "CPOOLADDRESS",
      contractId: "CCONTRACTADDRESS",
      ledgerSeq: 50,
      deltaA: "1",
      deltaB: "0",
      action: "database_resync_triggered",
    });
    expect(notifications.sendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AlertType.AMM_RESERVE_DIVERGENCE,
        severity: AlertSeverity.HIGH,
        service: "amm-reserve-divergence-detector",
      }),
    );
  });

  it("triggers database re-sync only for affected pool addresses", async () => {
    const matchingPool: DatabasePoolReserveRecord = {
      ...pool,
      poolAddress: "CPOOLMATCH",
    };
    const divergentPool: DatabasePoolReserveRecord = {
      ...pool,
      poolAddress: "CPOOLDIVERGED",
      reserveA: "500",
      reserveB: "600",
    };
    const store = makeStore([matchingPool, divergentPool]);
    const reader = makeReader({
      CPOOLMATCH: [100n, 200n],
      CPOOLDIVERGED: [500n, 601n],
    });
    const notifications = { sendAlert: jest.fn(() => Promise.resolve(true)) };
    const detector = new AmmReserveDivergenceDetector(
      store,
      reader,
      notifications,
      { intervalLedgers: 50, pollIntervalMs: 1000 },
    );

    const divergences = await detector.onNewLedger(50);

    expect(divergences).toHaveLength(1);
    expect(divergences[0]?.poolAddress).toBe("CPOOLDIVERGED");
    expect(store.resyncPoolReserves).toHaveBeenCalledTimes(1);
    expect(store.resyncPoolReserves).toHaveBeenCalledWith(
      expect.objectContaining({ poolAddress: "CPOOLDIVERGED" }),
      expect.objectContaining({
        poolAddress: "CPOOLDIVERGED",
        ledgerSeq: 50,
        reserveA: 500n,
        reserveB: 601n,
      }),
    );
  });
});
