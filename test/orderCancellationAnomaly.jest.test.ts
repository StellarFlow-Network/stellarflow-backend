import { describe, expect, it } from "@jest/globals";
import {
  calculateOrderBookImbalance,
  evaluateCancellationRatio,
  pruneWindow,
  resolveCancellationThresholds,
  type CancellationRatioThresholds,
  type OrderFlowEvent,
} from "../src/logic/orderCancellationAnomaly";

const thresholds: CancellationRatioThresholds = {
  windowMs: 60_000,
  ratioThreshold: 0.95,
  minPlacements: 5,
};

const event = (
  type: OrderFlowEvent["type"],
  timestamp: number,
  identifier = "acct",
): OrderFlowEvent => ({ identifier, type, timestamp });

describe("pruneWindow", () => {
  it("drops events older than the rolling window", () => {
    const events = [
      event("placed", 0),
      event("placed", 30_000),
      event("cancelled", 61_000),
    ];
    expect(pruneWindow(events, 61_000, 60_000)).toEqual([
      event("placed", 30_000),
      event("cancelled", 61_000),
    ]);
  });
});

describe("evaluateCancellationRatio", () => {
  it("does not flag accounts below the minimum placement count", () => {
    const events = [
      event("placed", 0),
      event("placed", 1),
      event("cancelled", 2),
      event("cancelled", 3),
    ];
    const result = evaluateCancellationRatio("acct", events, 10, thresholds);
    expect(result.flagged).toBe(false);
    expect(result.cancellationRatio).toBe(1);
    expect(result.reason).toContain("required orders placed");
  });

  it("does not flag a ratio exactly equal to the threshold", () => {
    const events = [
      ...Array.from({ length: 20 }, (_, i) => event("placed", i)),
      ...Array.from({ length: 19 }, (_, i) => event("cancelled", i)),
    ];
    const result = evaluateCancellationRatio("acct", events, 100, thresholds);
    expect(result.cancellationRatio).toBeCloseTo(0.95, 10);
    expect(result.flagged).toBe(false);
  });

  it("flags a ratio strictly above the threshold", () => {
    const events = [
      ...Array.from({ length: 6 }, (_, i) => event("placed", i)),
      ...Array.from({ length: 6 }, (_, i) => event("cancelled", i)),
    ];
    const result = evaluateCancellationRatio("acct", events, 100, thresholds);
    expect(result.flagged).toBe(true);
    expect(result.cancellationRatio).toBe(1);
    expect(result.reason).toBeUndefined();
  });

  it("treats a zero-placement window as zero ratio", () => {
    const result = evaluateCancellationRatio("acct", [], 100, thresholds);
    expect(result.cancellationRatio).toBe(0);
    expect(result.flagged).toBe(false);
  });
});

describe("resolveCancellationThresholds", () => {
  it("falls back to the documented defaults", () => {
    expect(resolveCancellationThresholds({})).toEqual({
      windowMs: 60_000,
      ratioThreshold: 0.95,
      minPlacements: 5,
    });
  });

  it("honours environment overrides", () => {
    expect(
      resolveCancellationThresholds({
        ORDER_CANCEL_WINDOW_MS: "30000",
        ORDER_CANCEL_RATIO_THRESHOLD: "0.8",
        ORDER_CANCEL_MIN_PLACEMENTS: "3",
      }),
    ).toEqual({ windowMs: 30_000, ratioThreshold: 0.8, minPlacements: 3 });
  });

  it("ignores invalid values", () => {
    expect(
      resolveCancellationThresholds({
        ORDER_CANCEL_WINDOW_MS: "-1",
        ORDER_CANCEL_RATIO_THRESHOLD: "1.5",
        ORDER_CANCEL_MIN_PLACEMENTS: "abc",
      }),
    ).toEqual({
      windowMs: 60_000,
      ratioThreshold: 0.95,
      minPlacements: 5,
    });
  });
});

describe("calculateOrderBookImbalance", () => {
  it("returns a positive ratio when bid depth dominates", () => {
    const imbalance = calculateOrderBookImbalance(
      [{ price: 100, quantity: 8 }],
      [{ price: 101, quantity: 2 }],
    );
    expect(imbalance.bidDepth).toBe(8);
    expect(imbalance.askDepth).toBe(2);
    expect(imbalance.imbalanceRatio).toBeCloseTo(0.6, 10);
    expect(imbalance.direction).toBe("bid");
  });

  it("returns a negative ratio when ask depth dominates", () => {
    const imbalance = calculateOrderBookImbalance(
      [{ price: 100, quantity: 1 }],
      [{ price: 101, quantity: 3 }],
    );
    expect(imbalance.imbalanceRatio).toBeCloseTo(-0.5, 10);
    expect(imbalance.direction).toBe("ask");
  });

  it("reports balanced when depths are equal or empty", () => {
    expect(
      calculateOrderBookImbalance(
        [{ price: 100, quantity: 4 }],
        [{ price: 101, quantity: 4 }],
      ).direction,
    ).toBe("balanced");
    expect(calculateOrderBookImbalance([], []).imbalanceRatio).toBe(0);
  });

  it("ignores non-finite and non-positive quantities", () => {
    const imbalance = calculateOrderBookImbalance(
      [
        { price: 100, quantity: Number.NaN },
        { price: 99, quantity: -5 },
        { price: 98, quantity: 3 },
      ],
      [],
    );
    expect(imbalance.bidDepth).toBe(3);
  });
});
