/**
 * Concentrated liquidity swap-fee projection (Issue #1047).
 *
 * Estimates the swap fees a prospective LP position would earn based on the
 * pool's recent trading volume:
 *
 *     S_fee = (L_user / L_total) * Volume_24h * Fee_tier
 *
 * The module is intentionally pure — it performs no I/O — so the projection
 * maths can be unit tested without a database and reused by any data source
 * (Prisma today, Soroban RPC later).
 */

/** Raised when the projection inputs violate a domain invariant. */
export class FeeProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeeProjectionError";
  }
}

/**
 * Assumed pool fee tier (0.30%) used only when the caller supplies neither an
 * explicit tier nor enough volume history to derive the pool's realised tier.
 */
export const DEFAULT_FEE_TIER = 0.003;

export interface FeeProjectionInput {
  /** Target liquidity the LP would add, in pool liquidity units. Must be > 0. */
  liquidityAmount: number;
  /**
   * Total liquidity currently active in the pool, in the same units as
   * `liquidityAmount`. Must be > 0.
   */
  totalLiquidity: number;
  /** Swap volume over the last 24 hours, in quote units. Must be >= 0. */
  volume24h: number;
  /**
   * Pool fee tier as a decimal fraction (`0.003` = 0.30%). Must satisfy
   * `0 < feeTier < 1`.
   */
  feeTier: number;
  /** Lower bound of the position's price range. Must be > 0. */
  priceLower: number;
  /** Upper bound of the position's price range. Must be > `priceLower`. */
  priceUpper: number;
  /**
   * Current pool price. When supplied, a range that excludes the spot price is
   * out of range and earns nothing, so the projection collapses to zero. When
   * omitted the range is not evaluated and the projection assumes the position
   * is in range.
   */
  currentPrice?: number;
}

export interface FeeProjection {
  /** `L_user / L_total`, the position's pro-rata claim on in-range fees. */
  liquidityShare: number;
  /** Projected 24-hour fees: `liquidityShare * volume24h * feeTier`. */
  projectedFees24h: number;
  /** Projected 24-hour fees extrapolated over a full year (365 days). */
  projectedFeesAnnualized: number;
  /**
   * `projectedFeesAnnualized / liquidityAmount * 100`. Meaningful only when
   * `liquidityAmount` is denominated in the same unit as the swap volume.
   */
  projectedFeeAprPercent: number;
  /**
   * `false` only when `currentPrice` is known and sits outside
   * `[priceLower, priceUpper]`. `null` when the spot price is unknown.
   */
  inRange: boolean | null;
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new FeeProjectionError(`${name} must be a positive finite number.`);
  }
}

/**
 * Project the fees a concentrated liquidity position would earn over 24 hours.
 *
 * A concentrated position only accrues fees while the pool's spot price trades
 * inside its range. When `currentPrice` is provided and falls outside
 * `[priceLower, priceUpper]` the position is inactive and earns nothing, so the
 * function returns a zero projection rather than the unconditional pro-rata
 * share. Reporting the unconditional share in that case would overstate
 * earnings for every range the market has left behind.
 *
 * @throws {FeeProjectionError} when an input violates a domain invariant, e.g.
 * a non-positive liquidity denominator, an inverted price range, or a target
 * liquidity larger than the pool's own liquidity.
 */
export function projectConcentratedLiquidityFees(
  input: FeeProjectionInput,
): FeeProjection {
  const {
    liquidityAmount,
    totalLiquidity,
    volume24h,
    feeTier,
    priceLower,
    priceUpper,
    currentPrice,
  } = input;

  assertPositiveFinite("liquidityAmount", liquidityAmount);
  assertPositiveFinite("totalLiquidity", totalLiquidity);

  if (!Number.isFinite(volume24h) || volume24h < 0) {
    throw new FeeProjectionError(
      "volume24h must be a non-negative finite number.",
    );
  }

  if (!Number.isFinite(feeTier) || feeTier <= 0 || feeTier >= 1) {
    throw new FeeProjectionError(
      "feeTier must be a decimal fraction between 0 and 1 (exclusive).",
    );
  }

  assertPositiveFinite("priceLower", priceLower);
  assertPositiveFinite("priceUpper", priceUpper);
  if (priceLower >= priceUpper) {
    throw new FeeProjectionError(
      "priceLower must be strictly less than priceUpper.",
    );
  }

  // The share is undefined when the target exceeds the pool it is measured
  // against; clamping it to 1 would silently report a fictional position.
  if (liquidityAmount > totalLiquidity) {
    throw new FeeProjectionError(
      "liquidityAmount cannot exceed the pool's total liquidity.",
    );
  }

  if (
    currentPrice !== undefined &&
    (!Number.isFinite(currentPrice) || currentPrice <= 0)
  ) {
    throw new FeeProjectionError(
      "currentPrice must be a positive finite number when provided.",
    );
  }

  const liquidityShare = liquidityAmount / totalLiquidity;

  // The upper bound is inclusive: a price sitting exactly on a boundary is
  // still inside the position's tick range.
  const inRange =
    currentPrice === undefined
      ? null
      : currentPrice >= priceLower && currentPrice <= priceUpper;

  const projectedFees24h =
    inRange === false ? 0 : liquidityShare * volume24h * feeTier;
  const projectedFeesAnnualized = projectedFees24h * 365;
  const projectedFeeAprPercent =
    (projectedFeesAnnualized / liquidityAmount) * 100;

  return {
    liquidityShare,
    projectedFees24h,
    projectedFeesAnnualized,
    projectedFeeAprPercent,
    inRange,
  };
}
