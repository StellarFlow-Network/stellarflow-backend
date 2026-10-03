import type { RebalancingPlan, ValuedReserve } from "./types";

export const RESERVE_RATIO_UPPER_BOUND = 0.7;

export const CONCENTRATED_LIQUIDITY_RANGE_PERCENT = 0.1;
const TICK_BASE = 1.0001;

export interface ConcentratedLiquidityPositionSnapshot {
  positionId: string;
  ownerId: string;
  poolKey: string;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  currentPrice: number;
}

export interface ConcentratedLiquidityRebalancingSuggestion {
  positionId: string;
  ownerId: string;
  poolKey: string;
  currentPrice: number;
  recommendedLowerPrice: number;
  recommendedUpperPrice: number;
  recommendedTickLower: number;
  recommendedTickUpper: number;
}

/** Return a new price range when a concentrated-liquidity position is out of range. */
export function suggestConcentratedLiquidityRebalance(
  position: ConcentratedLiquidityPositionSnapshot,
): ConcentratedLiquidityRebalancingSuggestion | null {
  const { currentPrice, currentTick, tickLower, tickUpper } = position;
  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0 ||
    !Number.isInteger(currentTick) ||
    !Number.isInteger(tickLower) ||
    !Number.isInteger(tickUpper) ||
    tickLower >= tickUpper
  ) {
    throw new Error(`Position ${position.positionId} has invalid price or ticks`);
  }

  if (currentTick >= tickLower && currentTick < tickUpper) return null;

  const recommendedLowerPrice =
    currentPrice * (1 - CONCENTRATED_LIQUIDITY_RANGE_PERCENT);
  const recommendedUpperPrice =
    currentPrice * (1 + CONCENTRATED_LIQUIDITY_RANGE_PERCENT);
  const recommendedTickLower = Math.floor(
    Math.log(recommendedLowerPrice) / Math.log(TICK_BASE),
  );
  const recommendedTickUpper = Math.ceil(
    Math.log(recommendedUpperPrice) / Math.log(TICK_BASE),
  );

  return {
    positionId: position.positionId,
    ownerId: position.ownerId,
    poolKey: position.poolKey,
    currentPrice,
    recommendedLowerPrice,
    recommendedUpperPrice,
    recommendedTickLower,
    recommendedTickUpper,
  };
}

/**
 * Returns the swap required to bring a breached reserve pair back to 50/50.
 * Reserve values must be normalized into the same unit (XLM in production).
 */
export function calculateRebalancingPlan(
  poolKey: string,
  anchorAccount: string,
  reserves: [ValuedReserve, ValuedReserve],
  managerAccounts: string[],
): RebalancingPlan | null {
  const [first, second] = reserves;
  const totalValue = first.normalizedValue + second.normalizedValue;

  if (
    !Number.isFinite(totalValue) ||
    totalValue <= 0 ||
    first.normalizedValue < 0 ||
    second.normalizedValue < 0
  ) {
    throw new Error(`Pool ${poolKey} contains invalid reserve values`);
  }

  const firstRatio = first.normalizedValue / totalValue;
  if (
    firstRatio <= RESERVE_RATIO_UPPER_BOUND &&
    firstRatio >= 1 - RESERVE_RATIO_UPPER_BOUND
  ) {
    return null;
  }

  const [from, to, fromRatio, toRatio] =
    firstRatio > RESERVE_RATIO_UPPER_BOUND
      ? [first, second, firstRatio, 1 - firstRatio]
      : [second, first, 1 - firstRatio, firstRatio];

  const normalizedVolume = (from.normalizedValue - to.normalizedValue) / 2;

  return {
    poolKey,
    anchorAccount,
    fromCurrency: from.code,
    toCurrency: to.code,
    fromAmount: normalizedVolume * from.unitsPerXlm,
    estimatedToAmount: normalizedVolume * to.unitsPerXlm,
    normalizedVolume,
    fromReserveRatio: fromRatio,
    toReserveRatio: toRatio,
    managerAccounts: [...managerAccounts],
  };
}


// ---------------------------------------------------------------------------
// Flash loan arbitrage risk inspector (#993)
// ---------------------------------------------------------------------------

/**
 * A single flash loan extracting more than this share of pool liquidity within
 * one block is treated as a manipulation vector, per the issue's 5% threshold.
 */
export const FLASH_LOAN_EXTRACTION_THRESHOLD = 0.05;

export interface FlashLoanEvent {
  txHash: string;
  /** Ledger (block) the loan was observed in. */
  ledger: number;
  poolKey: string;
  /** Amount borrowed, in the pool's units. */
  amount: number;
  /** Pool liquidity immediately before the loan was taken. */
  poolLiquidityBefore: number;
  /** Pool liquidity immediately after the loan was repaid. */
  poolLiquidityAfter: number;
  /** Whether principal plus fee was returned. */
  repaid: boolean;
}

export interface FlashLoanRiskAssessment {
  txHash: string;
  poolKey: string;
  ledger: number;
  /**
   * Net reserve impact, `after - before`. Negative means the pool ended the
   * transaction smaller than it started.
   */
  netReserveImpact: number;
  /**
   * Share of `poolLiquidityBefore` that left the pool. Zero when the pool grew,
   * since growth is not extraction.
   */
  liquidityShare: number;
  isManipulationRisk: boolean;
  reason?: string;
}

/**
 * Assess one flash loan for pool manipulation.
 *
 * The metric is the net reserve impact across the transaction, not the amount
 * borrowed: a loan that is borrowed and fully repaid leaves no trace, while one
 * that is borrowed and never returned drains the pool. A zero or negative
 * `poolLiquidityBefore` is rejected rather than divided by, since the share is
 * undefined without a denominator and a `NaN` comparison would silently pass.
 */
export function assessFlashLoanRisk(
  event: FlashLoanEvent,
  threshold: number = FLASH_LOAN_EXTRACTION_THRESHOLD,
): FlashLoanRiskAssessment {
  const { poolLiquidityBefore } = event;

  if (!Number.isFinite(poolLiquidityBefore) || poolLiquidityBefore <= 0) {
    throw new Error(
      `Pool ${event.poolKey} reported non-positive liquidity before flash loan ${event.txHash}`,
    );
  }

  const netReserveImpact = event.poolLiquidityAfter - poolLiquidityBefore;

  // Only a *drain* counts. A repaid loan normally leaves the pool larger,
  // because the fee accrues to it, so taking the absolute change would flag
  // every profitable flash loan once fees passed the threshold. Growth is not
  // extraction and is scored as zero.
  const liquidityShare =
    netReserveImpact < 0 ? -netReserveImpact / poolLiquidityBefore : 0;

  const unrepaid = !event.repaid;
  const isManipulationRisk = unrepaid || liquidityShare > threshold;

  const reason = unrepaid
    ? "flash loan was not repaid"
    : liquidityShare > threshold
      ? `extracted ${(liquidityShare * 100).toFixed(2)}% of pool liquidity (threshold ${(threshold * 100).toFixed(0)}%)`
      : undefined;

  return {
    txHash: event.txHash,
    poolKey: event.poolKey,
    ledger: event.ledger,
    netReserveImpact,
    liquidityShare,
    isManipulationRisk,
    ...(reason === undefined ? {} : { reason }),
  };
}

export interface FlashLoanVolumeSummary {
  eventCount: number;
  totalVolume: number;
  flaggedCount: number;
  unrepaidCount: number;
  /** Per-pool event and flagged counts, keyed by pool. */
  byPool: Record<string, { events: number; volume: number; flagged: number }>;
}

/**
 * Aggregate a batch of events into the counters a Prometheus scrape needs.
 *
 * Kept as a pure function so the collector registration stays in whatever owns
 * the registry; this returns the values, it does not publish them.
 */
export function summarizeFlashLoanVolume(
  events: readonly FlashLoanEvent[],
  threshold: number = FLASH_LOAN_EXTRACTION_THRESHOLD,
): FlashLoanVolumeSummary {
  const byPool: FlashLoanVolumeSummary["byPool"] = {};
  let totalVolume = 0;
  let flaggedCount = 0;
  let unrepaidCount = 0;

  for (const event of events) {
    const entry = byPool[event.poolKey] ?? { events: 0, volume: 0, flagged: 0 };
    entry.events += 1;
    entry.volume += event.amount;
    byPool[event.poolKey] = entry;

    totalVolume += event.amount;
    if (!event.repaid) unrepaidCount += 1;
    if (assessFlashLoanRisk(event, threshold).isManipulationRisk) {
      flaggedCount += 1;
      entry.flagged += 1;
    }
  }

  return {
    eventCount: events.length,
    totalVolume,
    flaggedCount,
    unrepaidCount,
    byPool,
  };
}

// ---------------------------------------------------------------------------
// Concentrated liquidity position realized PnL (#997)
// ---------------------------------------------------------------------------

/** 2^128, the fixed-point denominator used by CL fee growth accumulators. */
export const Q128 = 1n << 128n;

export interface FeeGrowthSnapshot {
  tickLower: number;
  tickUpper: number;
  /** Inside-fee growth per unit of liquidity for token 0, as a raw u128. */
  feeGrowthGlobal0X128: bigint;
  /** Inside-fee growth per unit of liquidity for token 1, as a raw u128. */
  feeGrowthGlobal1X128: bigint;
  /** Position liquidity while in range. */
  liquidity: bigint;
  /** Snapshot time, unix seconds. */
  timestamp: number;
}

export interface ConcentratedLiquidityPosition {
  positionId: string;
  poolKey: string;
  tickLower: number;
  tickUpper: number;
  /** Underlying value when the position was opened, as a raw u128. */
  initialValueX128: bigint;
  /** Underlying value now, as a raw u128. */
  currentValueX128: bigint;
  startSnapshot: FeeGrowthSnapshot;
  endSnapshot: FeeGrowthSnapshot;
  /**
   * Value of simply holding the deposited tokens since `startSnapshot`.
   * Impermanent loss is only meaningful against a benchmark, so this is an
   * input rather than something derivable from the position alone.
   */
  holdValueX128?: bigint;
}

export interface PositionPnl {
  positionId: string;
  initialValue: bigint;
  currentValue: bigint;
  feesCollected0: bigint;
  feesCollected1: bigint;
  /** `currentValue + feesCollected - initialValue`, per the issue. */
  netValue: bigint;
  /** `netValue - initialValue`. */
  realizedPnl: bigint;
  /**
   * `holdValue - currentValue`, positive when the position underperformed
   * holding. Absent when no benchmark was supplied.
   */
  impermanentLoss?: bigint;
  inRange: boolean;
  /**
   * False when a fee growth accumulator went backwards, which should be
   * impossible and means the snapshots cannot be trusted.
   */
  isFeeGrowthMonotonic: boolean;
}

/**
 * Compute realized PnL and impermanent loss for a concentrated liquidity
 * position.
 *
 * Fees are `liquidity * deltaFeeGrowth / Q128`, evaluated in `bigint` because
 * accumulators are u128 and lose precision as doubles well before the values
 * that matter. Division truncates, matching how the protocol rounds fees down.
 *
 * A backwards accumulator is reported rather than subtracted: a negative delta
 * would otherwise produce a negative fee and quietly inflate the result, so the
 * fees are zeroed and `isFeeGrowthMonotonic` is false.
 */
export function calculatePositionPnl(
  position: ConcentratedLiquidityPosition,
): PositionPnl {
  const start = position.startSnapshot;
  const end = position.endSnapshot;
  // Fees accrue against the liquidity the position held over the window, taken
  // from the closing snapshot; an out-of-range position holds none.
  const liquidity = end.liquidity;

  const delta0 = end.feeGrowthGlobal0X128 - start.feeGrowthGlobal0X128;
  const delta1 = end.feeGrowthGlobal1X128 - start.feeGrowthGlobal1X128;
  const isFeeGrowthMonotonic = delta0 >= 0n && delta1 >= 0n;

  const feesCollected0 = isFeeGrowthMonotonic ? (liquidity * delta0) / Q128 : 0n;
  const feesCollected1 = isFeeGrowthMonotonic ? (liquidity * delta1) / Q128 : 0n;

  const netValue =
    position.currentValueX128 + feesCollected0 + feesCollected1 - position.initialValueX128;

  const holdValueX128 = position.holdValueX128;
  const impermanentLoss =
    holdValueX128 === undefined ? undefined : holdValueX128 - position.currentValueX128;

  return {
    positionId: position.positionId,
    initialValue: position.initialValueX128,
    currentValue: position.currentValueX128,
    feesCollected0,
    feesCollected1,
    netValue,
    realizedPnl: netValue - position.initialValueX128,
    ...(impermanentLoss === undefined ? {} : { impermanentLoss }),
    inRange: end.tickLower === start.tickLower && end.tickUpper === start.tickUpper,
    isFeeGrowthMonotonic,
  };
}
