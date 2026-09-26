/**
 * Unit tests for RelayerGasReserveAllocator (Issue #1058).
 *
 * Acceptance criteria covered:
 *  - 20% of relayer wallets are reserved for emergency operations
 *  - standard trade/deposit operations can never consume emergency wallet gas
 *  - emergency wallet balances are monitored (and alerted) independently
 */
import { describe, it, expect, jest } from "@jest/globals";
import {
  GasReserveExhaustedError,
  RelayerGasReserveAllocator,
  partitionWallets,
  reservedWalletCount,
  type LowBalanceAlert,
  type RelayerGasReserveConfig,
  type RelayerGasWallet,
} from "../src/services/relayerGasReserveAllocator";

const wallets = (n: number): RelayerGasWallet[] =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, publicKey: `G${i + 1}` }));

/** Build an allocator over `count` wallets with the given balances by publicKey. */
function setup(
  count: number,
  balances: Record<string, number | Error>,
  config: Partial<RelayerGasReserveConfig> = {},
) {
  let clock = 1_000_000;
  const alerts: LowBalanceAlert[] = [];
  const fetchBalanceXlm = jest.fn(async (pk: string) => {
    const value = balances[pk] ?? 100;
    if (value instanceof Error) throw value;
    return value;
  });
  const listWallets = jest.fn(async () => wallets(count));
  const allocator = new RelayerGasReserveAllocator(
    {
      listWallets,
      fetchBalanceXlm,
      alert: async (a) => {
        alerts.push(a);
      },
      now: () => clock,
    },
    { balanceCacheTtlMs: 1000, ...config },
  );
  return {
    allocator,
    alerts,
    fetchBalanceXlm,
    listWallets,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("reserve sizing", () => {
  it.each([
    [0, 0],
    [1, 0], // cannot split a single wallet
    [2, 1],
    [5, 1], // exactly 20%
    [6, 2], // 20% rounds up
    [10, 2],
    [11, 3],
    [100, 20],
  ])("reserves %i wallets fleet -> %i emergency", (total, expected) => {
    expect(reservedWalletCount(total, 0.2)).toBe(expected);
  });

  it("never reserves the entire fleet", () => {
    expect(reservedWalletCount(2, 0.99)).toBe(1);
    expect(reservedWalletCount(3, 0.99)).toBe(2);
  });
});

describe("partitionWallets", () => {
  it("reserves the oldest wallets regardless of input order", () => {
    const shuffled = [wallets(10)[7]!, wallets(10)[0]!, ...wallets(10).slice(1, 7), wallets(10)[8]!, wallets(10)[9]!];
    const { emergency, standard } = partitionWallets(shuffled, 0.2);

    expect(emergency.map((w) => w.id)).toEqual([1, 2]);
    expect(standard.map((w) => w.id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("never moves an existing reserved wallet out of the reserve as the fleet grows", () => {
    const before = partitionWallets(wallets(5), 0.2).emergency.map((w) => w.id);
    const after = partitionWallets(wallets(9), 0.2).emergency.map((w) => w.id);
    for (const id of before) expect(after).toContain(id);
  });

  it("does not mutate its input", () => {
    const input = [wallets(3)[2]!, wallets(3)[0]!, wallets(3)[1]!];
    partitionWallets(input, 0.2);
    expect(input.map((w) => w.id)).toEqual([3, 1, 2]);
  });
});

describe("acquire", () => {
  it("only ever hands standard operations standard wallets", async () => {
    const { allocator } = setup(10, {}); // wallets 1-2 emergency
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const lease = await allocator.acquire("STANDARD");
      expect(lease.pool).toBe("STANDARD");
      seen.add(lease.wallet.id);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("blocks standard operations rather than spilling into the emergency pool", async () => {
    // Every standard wallet is drained; emergency wallets are flush.
    const balances: Record<string, number> = {};
    for (let i = 3; i <= 10; i++) balances[`G${i}`] = 0.5;
    const { allocator } = setup(10, balances);

    await expect(allocator.acquire("STANDARD")).rejects.toBeInstanceOf(GasReserveExhaustedError);
    // ...while the reserve is still untouched and usable for an emergency.
    const lease = await allocator.acquire("EMERGENCY");
    expect(lease.pool).toBe("EMERGENCY");
  });

  it("serves emergency operations from the emergency pool first", async () => {
    const { allocator } = setup(10, {});
    for (let i = 0; i < 10; i++) {
      const lease = await allocator.acquire("EMERGENCY");
      expect(lease).toMatchObject({ pool: "EMERGENCY", operation: "EMERGENCY" });
      expect([1, 2]).toContain(lease.wallet.id);
    }
  });

  it("falls back to the standard pool only when every emergency wallet is unusable", async () => {
    const { allocator } = setup(10, { G1: 0, G2: 1.9 });

    const lease = await allocator.acquire("EMERGENCY");

    expect(lease.pool).toBe("STANDARD");
    expect(lease.operation).toBe("EMERGENCY");
    expect(lease.wallet.id).toBeGreaterThanOrEqual(3);
  });

  it("skips wallets below the minimum operating balance and wallets whose lookup failed", async () => {
    const { allocator } = setup(
      10,
      { G3: 1, G4: new Error("horizon down"), G5: 2 }, // G5 is exactly at the minimum
    );
    const ids = new Set<number>();
    for (let i = 0; i < 30; i++) ids.add((await allocator.acquire("STANDARD")).wallet.id);

    expect(ids.has(3)).toBe(false);
    expect(ids.has(4)).toBe(false);
    expect(ids.has(5)).toBe(true);
  });

  it("throws for an emergency op when nothing at all is funded", async () => {
    const drained: Record<string, number> = {};
    for (let i = 1; i <= 10; i++) drained[`G${i}`] = 0;
    const { allocator } = setup(10, drained);

    await expect(allocator.acquire("EMERGENCY")).rejects.toThrow(/emergency operation/);
  });

  it("round-robins across wallets in a pool", async () => {
    const { allocator } = setup(10, {});
    const picks: number[] = [];
    for (let i = 0; i < 8; i++) picks.push((await allocator.acquire("STANDARD")).wallet.id);
    expect(picks).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("with a single wallet there is no reserve, so it serves standard traffic", async () => {
    const { allocator } = setup(1, {});
    expect((await allocator.acquire("STANDARD")).wallet.id).toBe(1);
    expect((await allocator.getSnapshot()).reserveSatisfied).toBe(false);
  });

  it("caches balances for the TTL and refreshes afterwards", async () => {
    const { allocator, fetchBalanceXlm, advance } = setup(5, {});

    await allocator.acquire("STANDARD");
    await allocator.acquire("STANDARD");
    expect(fetchBalanceXlm).toHaveBeenCalledTimes(5); // one round of lookups

    advance(1001);
    await allocator.acquire("STANDARD");
    expect(fetchBalanceXlm).toHaveBeenCalledTimes(10);
  });

  it("shares one balance round between concurrent callers", async () => {
    const { allocator, fetchBalanceXlm } = setup(5, {});
    await Promise.all(Array.from({ length: 20 }, () => allocator.acquire("STANDARD")));
    expect(fetchBalanceXlm).toHaveBeenCalledTimes(5);
  });
});

describe("independent emergency monitoring", () => {
  it("reports each pool against its own threshold", async () => {
    // Emergency threshold 50, standard threshold 20.
    const { allocator } = setup(10, { G1: 40, G2: 60, G3: 30, G4: 10 });

    const snap = await allocator.getSnapshot();

    expect(snap.emergency.thresholdXlm).toBe(50);
    expect(snap.emergency.lowBalanceWallets).toBe(1); // G1 (40 < 50)
    expect(snap.standard.thresholdXlm).toBe(20);
    expect(snap.standard.lowBalanceWallets).toBe(1); // G4 (10 < 20); G3 (30) is fine here
    expect(snap.emergency.totalBalanceXlm).toBe(100);
  });

  it("alerts on a low emergency wallet even when the standard pool is healthy", async () => {
    const { allocator, alerts } = setup(10, { G1: 12 });

    await allocator.refresh();

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ pool: "EMERGENCY", publicKey: "G1", balanceXlm: 12, thresholdXlm: 50 });
  });

  it("does not alert for wallets whose balance lookup failed", async () => {
    const { allocator, alerts } = setup(10, { G1: new Error("boom") });
    await allocator.refresh();
    expect(alerts).toHaveLength(0);
  });

  it("rate-limits repeat alerts per wallet and re-alerts after the interval", async () => {
    const { allocator, alerts, advance } = setup(10, { G1: 5 }, { alertIntervalMs: 60_000 });

    await allocator.refresh();
    advance(30_000);
    await allocator.refresh();
    expect(alerts).toHaveLength(1);

    advance(31_000);
    await allocator.refresh();
    expect(alerts).toHaveLength(2);
  });

  it("retries an alert on the next check when delivery failed", async () => {
    let calls = 0;
    const allocator = new RelayerGasReserveAllocator({
      listWallets: async () => wallets(10),
      fetchBalanceXlm: async (pk) => (pk === "G1" ? 5 : 100),
      alert: async () => {
        calls++;
        if (calls === 1) throw new Error("webhook down");
      },
    });

    await allocator.refresh(); // must not throw
    await allocator.refresh();

    expect(calls).toBe(2);
  });

  it("start() performs an immediate check and stop() halts the timer", async () => {
    jest.useFakeTimers();
    try {
      const { allocator, listWallets } = setup(5, {}, { checkIntervalMs: 1000 });
      await allocator.start();
      expect(listWallets).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(2500);
      expect(listWallets.mock.calls.length).toBeGreaterThanOrEqual(3);

      allocator.stop();
      const calls = listWallets.mock.calls.length;
      await jest.advanceTimersByTimeAsync(5000);
      expect(listWallets).toHaveBeenCalledTimes(calls);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("configuration", () => {
  it("rejects a reserve ratio outside (0, 1)", () => {
    const deps = { listWallets: async () => [], fetchBalanceXlm: async () => 0 };
    expect(() => new RelayerGasReserveAllocator(deps, { reserveRatio: 0 })).toThrow(RangeError);
    expect(() => new RelayerGasReserveAllocator(deps, { reserveRatio: 1 })).toThrow(RangeError);
  });
});
