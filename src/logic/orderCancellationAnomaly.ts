/**
 * Pure helpers for the Order Book Imbalance & Front-Running Anomaly Detector
 * (Issue #975).
 *
 * The detector watches the order lifecycle for each account (public key and/or
 * IP) and flags market participants whose order cancellation ratio
 * R_cancel = N_cancelled / N_placed crosses a configured threshold inside a
 * rolling one-minute window. A high cancellation ratio is a well-known
 * front-running / spoofing signal: orders are placed to create the appearance
 * of liquidity and then pulled before they can be filled.
 *
 * All window maths lives here so it stays free of I/O and trivially testable.
 */

export type OrderFlowEventType = "placed" | "cancelled";

export interface OrderFlowEvent {
  identifier: string;
  type: OrderFlowEventType;
  timestamp: number;
  ip?: string;
  publicKey?: string;
}

export interface CancellationRatioThresholds {
  /** Rolling window length in milliseconds. */
  windowMs: number;
  /** Ratio that must be *strictly exceeded* to flag an account. */
  ratioThreshold: number;
  /** Minimum placements required before a ratio is considered meaningful. */
  minPlacements: number;
}

export const DEFAULT_CANCELLATION_WINDOW_MS = 60_000;
export const DEFAULT_CANCELLATION_RATIO_THRESHOLD = 0.95;
export const DEFAULT_MIN_PLACEMENTS = 5;

type EnvSource = Record<string, string | undefined>;

/** Resolves thresholds from the environment, falling back to safe defaults. */
export function resolveCancellationThresholds(
  env: EnvSource = process.env,
): CancellationRatioThresholds {
  const windowMs = Number.parseInt(env.ORDER_CANCEL_WINDOW_MS ?? "", 10);
  const ratioThreshold = Number.parseFloat(
    env.ORDER_CANCEL_RATIO_THRESHOLD ?? "",
  );
  const minPlacements = Number.parseInt(
    env.ORDER_CANCEL_MIN_PLACEMENTS ?? "",
    10,
  );

  return {
    windowMs:
      Number.isFinite(windowMs) && windowMs > 0
        ? windowMs
        : DEFAULT_CANCELLATION_WINDOW_MS,
    ratioThreshold:
      Number.isFinite(ratioThreshold) &&
      ratioThreshold > 0 &&
      ratioThreshold < 1
        ? ratioThreshold
        : DEFAULT_CANCELLATION_RATIO_THRESHOLD,
    minPlacements:
      Number.isFinite(minPlacements) && minPlacements > 0
        ? minPlacements
        : DEFAULT_MIN_PLACEMENTS,
  };
}

export interface CancellationRatioEvaluation {
  identifier: string;
  placed: number;
  cancelled: number;
  cancellationRatio: number;
  flagged: boolean;
  windowMs: number;
  windowStart: number;
  windowEnd: number;
  /** Why no flag fired, for logging. Undefined when `flagged` is true. */
  reason?: string;
}

/**
 * Drops events that have aged out of the rolling window. The window is right
 * open, so an event exactly `windowMs` old is evicted.
 */
export function pruneWindow(
  events: readonly OrderFlowEvent[],
  now: number,
  windowMs: number,
): OrderFlowEvent[] {
  const cutoff = now - windowMs;
  return events.filter((event) => event.timestamp > cutoff);
}

/**
 * Computes R_cancel for the supplied window slice and decides whether the
 * account should be flagged. The ratio must strictly exceed the threshold, and
 * enough orders must have been placed for the ratio to be statistically
 * meaningful (a 1-of-1 cancel is not front-running).
 */
export function evaluateCancellationRatio(
  identifier: string,
  events: readonly OrderFlowEvent[],
  now: number,
  thresholds: CancellationRatioThresholds,
): CancellationRatioEvaluation {
  const placed = events.reduce(
    (count, event) => (event.type === "placed" ? count + 1 : count),
    0,
  );
  const cancelled = events.reduce(
    (count, event) => (event.type === "cancelled" ? count + 1 : count),
    0,
  );
  const cancellationRatio = placed > 0 ? cancelled / placed : 0;

  const base = {
    identifier,
    placed,
    cancelled,
    cancellationRatio,
    windowMs: thresholds.windowMs,
    windowStart: now - thresholds.windowMs,
    windowEnd: now,
  };

  if (placed < thresholds.minPlacements) {
    return {
      ...base,
      flagged: false,
      reason: `only ${placed} of ${thresholds.minPlacements} required orders placed in the window`,
    };
  }

  if (!(cancellationRatio > thresholds.ratioThreshold)) {
    return {
      ...base,
      flagged: false,
      reason: `cancellation ratio ${cancellationRatio.toFixed(4)} does not exceed ${thresholds.ratioThreshold}`,
    };
  }

  return { ...base, flagged: true };
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookImbalance {
  bidDepth: number;
  askDepth: number;
  /** (bidDepth - askDepth) / (bidDepth + askDepth), in [-1, 1]. */
  imbalanceRatio: number;
  direction: "bid" | "ask" | "balanced";
}

/**
 * Depth-weighted order book imbalance. A large positive value means resting bid
 * liquidity dominates (buy-side pressure); negative means ask-side dominates.
 */
export function calculateOrderBookImbalance(
  bids: readonly OrderBookLevel[],
  asks: readonly OrderBookLevel[],
): OrderBookImbalance {
  const sumQuantity = (levels: readonly OrderBookLevel[]): number =>
    levels.reduce(
      (total, level) =>
        Number.isFinite(level.quantity) && level.quantity > 0
          ? total + level.quantity
          : total,
      0,
    );

  const bidDepth = sumQuantity(bids);
  const askDepth = sumQuantity(asks);
  const total = bidDepth + askDepth;
  const imbalanceRatio = total > 0 ? (bidDepth - askDepth) / total : 0;

  let direction: OrderBookImbalance["direction"] = "balanced";
  if (imbalanceRatio > 0) direction = "bid";
  else if (imbalanceRatio < 0) direction = "ask";

  return { bidDepth, askDepth, imbalanceRatio, direction };
}
