import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  OrderBookImbalanceDetector,
  type OrderAnomalyRedisClient,
  type OrderBookImbalanceDetectorOptions,
} from "../src/services/orderBookImbalanceDetector";

const store = new Map<string, string>();
const fakeRedis = {
  isOpen: true,
  set: jest.fn(async (key: string, value: string) => {
    store.set(key, value);
    return "OK";
  }),
  get: jest.fn(async (key: string) => store.get(key) ?? null),
};

let nowValue = 1_000_000;
const clock = () => nowValue;

const sendAlert = jest.fn(async () => true);

const createDetector = (
  overrides: Partial<OrderBookImbalanceDetectorOptions> = {},
) =>
  new OrderBookImbalanceDetector({
    notifications: { sendAlert } as never,
    now: clock,
    thresholds: { windowMs: 60_000, ratioThreshold: 0.95, minPlacements: 5 },
    throttleMs: 300_000,
    redisProvider: () => fakeRedis as unknown as OrderAnomalyRedisClient,
    ...overrides,
  });

const place = (detector: OrderBookImbalanceDetector, count: number) =>
  Promise.all(
    Array.from({ length: count }, () =>
      detector.recordOrderFlow({ identifier: "acct", type: "placed" }),
    ),
  );

const cancel = (detector: OrderBookImbalanceDetector, count: number) =>
  Promise.all(
    Array.from({ length: count }, () =>
      detector.recordOrderFlow({ identifier: "acct", type: "cancelled" }),
    ),
  );

describe("OrderBookImbalanceDetector", () => {
  beforeEach(() => {
    store.clear();
    nowValue = 1_000_000;
    jest.clearAllMocks();
  });

  it("flags and throttles an account with a high cancellation ratio", async () => {
    const detector = createDetector();

    await place(detector, 6);
    const results = await cancel(detector, 6);
    const anomaly = results.at(-1);

    expect(anomaly).not.toBeNull();
    expect(anomaly?.cancellationRatio).toBe(1);
    expect(anomaly?.placed).toBe(6);
    expect(anomaly?.cancelled).toBe(6);
    expect(sendAlert).toHaveBeenCalledTimes(1);

    expect(await detector.isThrottled("acct")).toBe(true);

    const throttleKey = "order-anomaly:throttle:acct";
    expect(store.has(throttleKey)).toBe(true);
    expect(fakeRedis.set).toHaveBeenCalledWith(
      throttleKey,
      expect.any(String),
      { PX: 300_000 },
    );
  });

  it("does not flag accounts below the minimum placement count", async () => {
    const detector = createDetector();

    await place(detector, 4);
    const results = await cancel(detector, 4);

    expect(results.every((result) => result === null)).toBe(true);
    expect(sendAlert).not.toHaveBeenCalled();
    expect(await detector.isThrottled("acct")).toBe(false);
  });

  it("does not flag when the ratio equals the threshold", async () => {
    const detector = createDetector({
      thresholds: { windowMs: 60_000, ratioThreshold: 0.95, minPlacements: 1 },
    });

    const placements = await place(detector, 20);
    const cancellations = await cancel(detector, 19);

    expect(placements.every((result) => result === null)).toBe(true);
    expect(cancellations.every((result) => result === null)).toBe(true);
    expect(detector.getCancellationStats("acct").cancellationRatio).toBeCloseTo(
      0.95,
      10,
    );
  });

  it("evicts placements that fall outside the rolling window", async () => {
    const detector = createDetector();

    await place(detector, 5);
    nowValue += 61_000;

    const placed = await detector.recordOrderFlow({
      identifier: "acct",
      type: "placed",
    });
    const cancelled = await detector.recordOrderFlow({
      identifier: "acct",
      type: "cancelled",
    });

    expect(placed).toBeNull();
    expect(cancelled).toBeNull();
    const stats = detector.getCancellationStats("acct");
    expect(stats.placed).toBe(1);
    expect(stats.cancelled).toBe(1);
    expect(stats.flagged).toBe(false);
  });

  it("extends the throttle without re-alerting while already throttled", async () => {
    const detector = createDetector();

    await place(detector, 6);
    await cancel(detector, 6);
    expect(sendAlert).toHaveBeenCalledTimes(1);

    const second = await detector.recordOrderFlow({
      identifier: "acct",
      type: "cancelled",
    });

    expect(second).not.toBeNull();
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });

  it("expires the throttle after the configured duration", async () => {
    const detector = createDetector();

    await place(detector, 6);
    await cancel(detector, 6);
    expect(await detector.isThrottled("acct")).toBe(true);

    nowValue += 300_001;
    expect(await detector.isThrottled("acct")).toBe(false);
  });

  it("prefers public key over IP when bucketing order flow", async () => {
    const detector = createDetector();

    for (let i = 0; i < 6; i += 1) {
      await detector.recordOrderFlow({
        publicKey: "GABC",
        ip: "10.0.0.1",
        type: "placed",
      });
    }
    for (let i = 0; i < 6; i += 1) {
      await detector.recordOrderFlow({
        publicKey: "GABC",
        ip: "10.0.0.1",
        type: "cancelled",
      });
    }

    expect(store.has("order-anomaly:throttle:GABC")).toBe(true);
    expect(store.has("order-anomaly:throttle:10.0.0.1")).toBe(false);
  });

  it("requires an identifier", async () => {
    const detector = createDetector();
    await expect(detector.recordOrderFlow({ type: "placed" })).rejects.toThrow(
      /identifier/,
    );
  });

  it("falls back to memory when Redis is unavailable", async () => {
    const detector = createDetector({ redisProvider: () => null });

    await place(detector, 6);
    await cancel(detector, 6);

    expect(await detector.isThrottled("acct")).toBe(true);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });
});
