/**
 * E2E — Order Book Off-Chain Matching (issue #1061).
 *
 * Drives the real off-chain order-book services with a continuous, seeded
 * sequence of limit-order placement / cancellation / execution events and
 * reconciles the resulting book against the on-chain Soroban `OrderFilled`
 * settlement ledger:
 *
 *   - `OrderBookSynchronizer.processOrderEvent` — off-chain book state.
 *   - `OrderBookSnapshotEngine`                 — depth capture / recovery.
 *   - `parseOrderFilledEvent` / `verifyOrderFilledEvent`
 *                                               — on-chain settlement records.
 *
 * Redis, Socket.IO, Winston and Prisma are replaced by in-memory fakes so the
 * suite is deterministic and needs no external services:
 *
 *   npm run test:e2e -- orderBookMatching.e2e.test.ts
 */
import {
  OrderBookSynchronizer,
  type OrderBookSnapshot,
} from "../../src/services/orderBookSynchronizer";
import { OrderBookSnapshotEngine } from "../../src/services/orderBookSnapshotEngine";
import {
  parseOrderFilledEvent,
  verifyOrderFilledEvent,
} from "../../src/services/orderFillVerificationService";

/* ------------------------------------------------------------------ *
 * In-memory fakes (Redis / Socket.IO / Winston / Prisma)
 * ------------------------------------------------------------------ */

jest.mock("../../src/lib/redis", () => {
  const store = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();

  const client = {
    isOpen: true,
    isReady: true,
    get: async (key: string) => store.get(key) ?? null,
    setEx: async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return "OK";
    },
    del: async (...args: unknown[]) => {
      const keys = args.flat() as string[];
      for (const key of keys) {
        store.delete(key);
        zsets.delete(key);
      }
      return keys.length;
    },
    zAdd: async (key: string, entry: { score: number; value: string }) => {
      const set = zsets.get(key) ?? new Map<string, number>();
      set.set(entry.value, entry.score);
      zsets.set(key, set);
      return 1;
    },
    zRem: async (key: string, member: string) => {
      const set = zsets.get(key);
      return set?.delete(member) ? 1 : 0;
    },
    zRangeWithScores: async (key: string) => {
      const set = zsets.get(key) ?? new Map<string, number>();
      return [...set.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([value, score]) => ({ value, score }));
    },
    scanIterator: (options: { MATCH: string }) => {
      const regex = new RegExp(`^${options.MATCH.replaceAll("*", ".*")}$`);
      return (async function* iterateRedisKeys() {
        for (const key of [...store.keys()]) {
          if (regex.test(key)) yield [key];
        }
      })();
    },
  };

  (globalThis as unknown as Record<string, unknown>).__orderBookRedis = {
    store,
    zsets,
  };
  return {
    __esModule: true,
    getRedisClient: () => client,
    disconnectRedis: async () => undefined,
  };
});

jest.mock("../../src/lib/socket", () => ({
  __esModule: true,
  broadcastToSessions: () => undefined,
  initSocket: () => undefined,
}));

jest.mock("../../src/utils/logger", () => {
  const noop = () => undefined;
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fetcherError: noop,
    networkInfo: noop,
    networkError: noop,
  };
  return { __esModule: true, logger, createFetcherLogger: () => logger };
});

jest.mock("../../src/lib/prisma", () => {
  class FakeDecimal {
    private readonly raw: number;

    constructor(value: number | string | { valueOf(): number }) {
      this.raw = Number(value.valueOf());
    }

    add(other: number | string | { valueOf(): number }): FakeDecimal {
      return new FakeDecimal(this.raw + Number(other.valueOf()));
    }

    gte(other: number | string | { valueOf(): number }): boolean {
      return this.raw >= Number(other.valueOf());
    }

    valueOf(): number {
      return this.raw;
    }

    toString(): string {
      return String(this.raw);
    }
  }

  interface FakeOrderRow {
    orderId: string;
    totalAmount: FakeDecimal;
    filledAmount: FakeDecimal;
    status: string;
  }

  const orders = new Map<string, FakeOrderRow>();
  const events = new Map<string, unknown>();

  const transaction = {
    orderFilledEvent: {
      findUnique: async (args: {
        where: { txHash_eventIndex: { txHash: string; eventIndex: number } };
      }) =>
        events.get(
          `${args.where.txHash_eventIndex.txHash}:${args.where.txHash_eventIndex.eventIndex}`,
        ) ?? null,
      create: async (args: { data: Record<string, unknown> }) => {
        const record = { id: `evt-${events.size + 1}`, ...args.data };
        events.set(
          `${String(args.data.txHash)}:${String(args.data.eventIndex)}`,
          record,
        );
        return record;
      },
    },
    openOrder: {
      findUnique: async (args: { where: { orderId: string } }) =>
        orders.get(args.where.orderId) ?? null,
      update: async (args: {
        where: { orderId: string };
        data: Partial<FakeOrderRow>;
      }) => {
        const order = orders.get(args.where.orderId);
        if (order) Object.assign(order, args.data);
        return order ?? null;
      },
    },
  };

  const prisma = {
    $transaction: async (
      fn: (tx: typeof transaction) => Promise<unknown>,
    ): Promise<unknown> => fn(transaction),
  };

  (globalThis as unknown as Record<string, unknown>).__orderBookPrisma = {
    orders,
    events,
    seedOrder(orderId: string, total: number) {
      orders.set(orderId, {
        orderId,
        totalAmount: new FakeDecimal(total),
        filledAmount: new FakeDecimal(0),
        status: "open",
      });
    },
  };

  return { __esModule: true, default: prisma, prisma };
});

/* ------------------------------------------------------------------ *
 * Test helpers
 * ------------------------------------------------------------------ */

type Side = "bid" | "ask";

interface FakeDecimalLike {
  valueOf(): number;
  toString(): string;
}

interface FakeOrderRow {
  orderId: string;
  totalAmount: FakeDecimalLike;
  filledAmount: FakeDecimalLike;
  status: string;
}

interface PrismaFake {
  orders: Map<string, FakeOrderRow>;
  events: Map<string, unknown>;
  seedOrder(orderId: string, total: number): void;
}

interface RedisFake {
  store: Map<string, string>;
  zsets: Map<string, Map<string, number>>;
}

interface RefMarket {
  bids: Map<number, number>;
  asks: Map<number, number>;
}

interface PriceLevel {
  price: number;
  quantity: number;
}

interface LiveOrder {
  orderId: string;
  market: string;
  side: Side;
  price: number;
  total: number;
  filled: number;
}

function internal<T>(key: string): T {
  return (globalThis as unknown as Record<string, unknown>)[key] as T;
}

/** Deterministic PRNG so a 5,000-operation run is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyMarket(): RefMarket {
  return { bids: new Map<number, number>(), asks: new Map<number, number>() };
}

function sideMap(market: RefMarket, side: Side): Map<number, number> {
  return side === "bid" ? market.bids : market.asks;
}

function levelKey(market: string, side: Side, price: number): string {
  return `${market}|${side}|${price}`;
}

/** Independent reference book mirroring the documented synchroniser semantics. */
function refSnapshot(market: RefMarket): { bids: PriceLevel[]; asks: PriceLevel[]; spread: number | null } {
  const bids = [...market.bids.entries()]
    .sort((a, b) => b[0] - a[0])
    .slice(0, 25)
    .map(([price, quantity]) => ({ price, quantity }));
  const asks = [...market.asks.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, 25)
    .map(([price, quantity]) => ({ price, quantity }));

  let spread: number | null = null;
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  if (bestBid > 0 && bestAsk > 0) spread = bestAsk - bestBid;

  return { bids, asks, spread };
}

function snapshotMatches(snapshot: OrderBookSnapshot, market: RefMarket): boolean {
  const reference = refSnapshot(market);
  return (
    snapshot.spread === reference.spread &&
    JSON.stringify(snapshot.bids) === JSON.stringify(reference.bids) &&
    JSON.stringify(snapshot.asks) === JSON.stringify(reference.asks)
  );
}

describe("Order book off-chain matching (e2e)", () => {
  const OPERATION_COUNT = 5000;
  const MARKETS = ["XLMUSDC", "AQUAUSDC", "USDCNGN"];
  const BID_PRICES = [100, 101, 102, 103, 104];
  const ASK_PRICES = [105, 106, 107, 108, 109];

  beforeEach(() => {
    const redis = internal<RedisFake>("__orderBookRedis");
    redis.store.clear();
    redis.zsets.clear();

    const prisma = internal<PrismaFake>("__orderBookPrisma");
    prisma.orders.clear();
    prisma.events.clear();
  });

  test("reconciles 5,000 continuous place/cancel/execute operations against on-chain settlement", async () => {
    const synchronizer = new OrderBookSynchronizer();
    const prisma = internal<PrismaFake>("__orderBookPrisma");
    const random = mulberry32(0x5eed1061);

    const markets = new Map<string, RefMarket>();
    for (const market of MARKETS) markets.set(market, emptyMarket());

    const liveByKey = new Map<string, LiveOrder[]>();
    // Quantity at each level that is still backed by a live (not fully filled) order.
    const orderBackedQty = new Map<string, number>();

    const liveOrdersAt = (market: string, side: Side, price: number): LiveOrder[] =>
      (liveByKey.get(levelKey(market, side, price)) ?? []).filter(
        (order) => order.filled < order.total,
      );

    const failures: string[] = [];
    const counts = { created: 0, executed: 0, cancelled: 0 };
    let passed = 0;

    for (let op = 1; op <= OPERATION_COUNT; op++) {
      let failed = false;
      const check = (condition: boolean, message: string) => {
        if (!condition) {
          failed = true;
          if (failures.length < 25) failures.push(`op ${op}: ${message}`);
        }
      };

      const marketName = MARKETS[op % MARKETS.length] as string;
      const book = markets.get(marketName) as RefMarket;
      const side: Side = random() < 0.5 ? "bid" : "ask";
      const levels = sideMap(book, side);

      const roll = random();
      let action: "created" | "executed" | "cancelled" =
        roll < 0.45 ? "created" : roll < 0.75 ? "executed" : "cancelled";

      let snapshot: OrderBookSnapshot | null = null;

      if (action === "executed") {
        const candidates = [...levels.keys()].filter(
          (price) => liveOrdersAt(marketName, side, price).length > 0,
        );
        if (candidates.length === 0) {
          action = "created";
        } else {
          const price = candidates[Math.floor(random() * candidates.length)] as number;
          const order = liveOrdersAt(marketName, side, price)[0] as LiveOrder;
          const quantity = Math.min(
            order.total - order.filled,
            1 + Math.floor(random() * 3),
          );
          const txHash = `tx-${op.toString(16).padStart(8, "0")}`;
          const ledgerSeq = 1000 + Math.floor(op / 10);
          const eventIndex = op % 30;

          snapshot = await synchronizer.processOrderEvent({
            market: marketName,
            side,
            orderId: order.orderId,
            price,
            quantity,
            type: "executed",
          });
          counts.executed += 1;

          const nextLevelQty = Math.max(0, (levels.get(price) ?? 0) - quantity);
          if (nextLevelQty > 0) levels.set(price, nextLevelQty);
          else levels.delete(price);

          // On-chain: the Soroban OrderFilled event settles the same fill.
          const settled = await verifyOrderFilledEvent({
            txHash,
            ledger: ledgerSeq,
            index: eventIndex,
            topic: ["OrderFilled"],
            value: { orderId: order.orderId, fillAmount: String(quantity) },
          });
          check(settled, "Soroban OrderFilled settlement was not applied");

          order.filled += quantity;
          const key = levelKey(marketName, side, price);
          orderBackedQty.set(key, (orderBackedQty.get(key) ?? 0) - quantity);

          const persisted = prisma.orders.get(order.orderId);
          check(persisted !== undefined, "on-chain OpenOrder row is missing");
          check(
            persisted?.filledAmount.valueOf() === order.filled,
            `on-chain filledAmount ${persisted?.filledAmount.valueOf()} != off-chain ${order.filled}`,
          );
          check(
            persisted?.status ===
              (order.filled >= order.total ? "filled" : "partially_filled"),
            `on-chain status ${persisted?.status} does not match the fill state`,
          );

          // Drop fully-filled orders so the level only tracks open interest.
          liveByKey.set(
            key,
            (liveByKey.get(key) ?? []).filter((o) => o.filled < o.total),
          );
        }
      }

      if (action === "created") {
        const price = (
          side === "bid" ? BID_PRICES : ASK_PRICES
        )[Math.floor(random() * 5)] as number;
        const quantity = 1 + Math.floor(random() * 5);
        const orderId = `order-${op}`;

        prisma.seedOrder(orderId, quantity);
        snapshot = await synchronizer.processOrderEvent({
          market: marketName,
          side,
          orderId,
          price,
          quantity,
          type: "created",
        });
        counts.created += 1;

        levels.set(price, (levels.get(price) ?? 0) + quantity);
        const key = levelKey(marketName, side, price);
        orderBackedQty.set(key, (orderBackedQty.get(key) ?? 0) + quantity);
        liveByKey.set(key, [
          ...(liveByKey.get(key) ?? []),
          { orderId, market: marketName, side, price, total: quantity, filled: 0 },
        ]);
      }

      if (action === "cancelled") {
        const prices = [...levels.keys()];
        if (prices.length === 0) {
          action = "created";
        } else {
          const price = prices[Math.floor(random() * prices.length)] as number;
          snapshot = await synchronizer.processOrderEvent({
            market: marketName,
            side,
            orderId: `cancel-${op}`,
            price,
            quantity: levels.get(price) as number,
            type: "cancelled",
          });
          counts.cancelled += 1;

          levels.delete(price);
          const key = levelKey(marketName, side, price);
          liveByKey.delete(key);
          orderBackedQty.delete(key);
        }
      }

      if (snapshot) {
        check(snapshotMatches(snapshot, book), "off-chain book diverged from the reference state");
        check(
          snapshotMatches(await synchronizer.getDepth(marketName), book),
          "Redis-hydrated depth diverged from the reference state",
        );
      }

      // Every remaining level quantity must equal the open interest of the
      // orders that the on-chain ledger says are still unfilled.
      for (const bookSide of ["bid", "ask"] as const) {
        const sideLevels = sideMap(book, bookSide);
        const prefix = `${marketName}|${bookSide}|`;
        const keys = new Set<string>();
        for (const price of sideLevels.keys()) {
          keys.add(levelKey(marketName, bookSide, price));
        }
        for (const key of orderBackedQty.keys()) {
          if (key.startsWith(prefix)) keys.add(key);
        }
        for (const key of keys) {
          const price = Number(key.slice(prefix.length));
          const reference = sideLevels.get(price) ?? 0;
          const backed = orderBackedQty.get(key) ?? 0;
          check(
            reference === backed,
            `level ${key} off-chain=${reference} but order ledger=${backed}`,
          );
        }
      }

      if (!failed) passed += 1;
    }

    const passRate = (passed / OPERATION_COUNT) * 100;

    expect(failures).toEqual([]);
    expect(counts.created).toBeGreaterThan(0);
    expect(counts.executed).toBeGreaterThan(0);
    expect(counts.cancelled).toBeGreaterThan(0);
    expect(passed).toBe(OPERATION_COUNT);
    expect(passRate).toBe(100);
    expect(prisma.orders.size).toBeGreaterThan(0);
    expect(prisma.events.size).toBe(counts.executed);
  });

  test("applies placement, partial execution, full execution and cancellation semantics", async () => {
    const synchronizer = new OrderBookSynchronizer();
    const market = "SEMANTICSUSDC";

    await synchronizer.processOrderEvent({
      market,
      side: "bid",
      orderId: "a",
      price: 100,
      quantity: 5,
      type: "created",
    });
    await synchronizer.processOrderEvent({
      market,
      side: "bid",
      orderId: "b",
      price: 100,
      quantity: 3,
      type: "created",
    });
    expect((await synchronizer.getDepth(market)).bids).toEqual([
      { price: 100, quantity: 8 },
    ]);

    await synchronizer.processOrderEvent({
      market,
      side: "bid",
      orderId: "a",
      price: 100,
      quantity: 2,
      type: "executed",
    });
    expect((await synchronizer.getDepth(market)).bids).toEqual([
      { price: 100, quantity: 6 },
    ]);

    await synchronizer.processOrderEvent({
      market,
      side: "bid",
      orderId: "a",
      price: 100,
      quantity: 99,
      type: "executed",
    });
    expect((await synchronizer.getDepth(market)).bids).toEqual([]);

    await synchronizer.processOrderEvent({
      market,
      side: "ask",
      orderId: "c",
      price: 110,
      quantity: 4,
      type: "created",
    });
    await synchronizer.processOrderEvent({
      market,
      side: "ask",
      orderId: "d",
      price: 110,
      quantity: 6,
      type: "created",
    });
    await synchronizer.processOrderEvent({
      market,
      side: "ask",
      orderId: "c",
      price: 110,
      quantity: 4,
      type: "cancelled",
    });
    expect((await synchronizer.getDepth(market)).asks).toEqual([]);

    await synchronizer.processOrderEvent({
      market: "  xlm/usdc ",
      side: "buy",
      orderId: "e",
      price: 100,
      quantity: 1,
      type: "created",
    });
    await synchronizer.processOrderEvent({
      market: "XLM/USDC",
      side: "sell",
      orderId: "f",
      price: 108,
      quantity: 1,
      type: "created",
    });
    const normalized = await synchronizer.getDepth("xlm/usdc");
    expect(normalized.market).toBe("XLM/USDC");
    expect(normalized.spread).toBe(8);

    await expect(
      synchronizer.processOrderEvent({
        market: "",
        side: "bid",
        price: 1,
        quantity: 1,
        type: "created",
      }),
    ).rejects.toThrow(/market/i);
    await expect(
      synchronizer.processOrderEvent({
        market: "X",
        side: "bid",
        price: 0,
        quantity: 1,
        type: "created",
      }),
    ).rejects.toThrow(/price/i);
    await expect(
      synchronizer.processOrderEvent({
        market: "X",
        side: "sideways" as unknown as Side,
        price: 1,
        quantity: 1,
        type: "created",
      }),
    ).rejects.toThrow(/side/i);
    await expect(
      synchronizer.processOrderEvent({
        market: "X",
        side: "bid",
        price: 1,
        quantity: 1,
        type: "sideways" as unknown as "created",
      }),
    ).rejects.toThrow(/event type/i);
  });

  test("captures and recovers the matched book across ledger snapshots", async () => {
    const engine = new OrderBookSnapshotEngine({
      snapshotIntervalLedgers: 100,
      retentionDays: 1,
    });
    engine.setLevel("bid", 100, 5);
    engine.setLevel("bid", 101, 3);
    engine.setLevel("ask", 110, 7);

    const snapshot = await engine.captureSnapshot(4242);
    expect(snapshot?.bids).toEqual([
      { price: 101, amount: 3 },
      { price: 100, amount: 5 },
    ]);
    expect(snapshot?.asks).toEqual([{ price: 110, amount: 7 }]);

    const recovered = new OrderBookSnapshotEngine({
      snapshotIntervalLedgers: 100,
      retentionDays: 1,
    });
    const restored = await recovered.recoverFromLatestSnapshot();
    expect(restored?.ledgerSeq).toBe(4242);
    expect(recovered.getDepth()).toEqual(engine.getDepth());

    await expect(engine.purgeExpiredSnapshots()).resolves.toBe(0);
  });

  test("ignores non-settlement Soroban events and keeps fills idempotent", async () => {
    const prisma = internal<PrismaFake>("__orderBookPrisma");
    prisma.seedOrder("order-idem", 10);

    const event = {
      txHash: "tx-idem",
      ledger: 777,
      index: 2,
      topic: ["OrderFilled"],
      value: { orderId: "order-idem", fillAmount: "4" },
    };

    expect(
      parseOrderFilledEvent({ ...event, topic: ["OtherEvent"] }),
    ).toBeNull();
    expect(
      parseOrderFilledEvent({
        ...event,
        value: { orderId: "order-idem", fillAmount: "0" },
      }),
    ).toBeNull();
    expect(parseOrderFilledEvent(event)).toEqual({
      orderId: "order-idem",
      fillAmount: "4",
    });

    await expect(verifyOrderFilledEvent(event)).resolves.toBe(true);
    expect(prisma.orders.get("order-idem")?.filledAmount.valueOf()).toBe(4);
    expect(prisma.orders.get("order-idem")?.status).toBe("partially_filled");

    // Replaying the same ledger event must not double-count the fill.
    await expect(verifyOrderFilledEvent(event)).resolves.toBe(true);
    expect(prisma.orders.get("order-idem")?.filledAmount.valueOf()).toBe(4);
    expect(prisma.events.size).toBe(1);

    // An unrelated Soroban event never touches the settlement ledger.
    await expect(
      verifyOrderFilledEvent({ ...event, txHash: "tx-other", topic: ["Transfer"] }),
    ).resolves.toBe(false);
    expect(prisma.events.size).toBe(1);

    await expect(
      verifyOrderFilledEvent({
        ...event,
        txHash: "tx-final",
        index: 3,
        value: { orderId: "order-idem", fillAmount: "6" },
      }),
    ).resolves.toBe(true);
    expect(prisma.orders.get("order-idem")?.filledAmount.valueOf()).toBe(10);
    expect(prisma.orders.get("order-idem")?.status).toBe("filled");
  });
});
