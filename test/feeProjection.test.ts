import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FEE_TIER,
  FeeProjectionError,
  projectConcentratedLiquidityFees,
} from "../src/services/liquidity/feeProjection";

function closeTo(actual: number, expected: number, epsilon = 1e-9): boolean {
  return Math.abs(actual - expected) < epsilon;
}

const baseInput = {
  liquidityAmount: 10_000,
  totalLiquidity: 1_000_000,
  volume24h: 500_000,
  feeTier: 0.003,
  priceLower: 0.1,
  priceUpper: 0.2,
};

test("projects the pro-rata fee share from the issue formula", () => {
  const result = projectConcentratedLiquidityFees(baseInput);

  // S_fee = (10_000 / 1_000_000) * 500_000 * 0.003 = 15
  assert.ok(closeTo(result.liquidityShare, 0.01));
  assert.ok(closeTo(result.projectedFees24h, 15));
  assert.ok(closeTo(result.projectedFeesAnnualized, 15 * 365));
  assert.ok(closeTo(result.projectedFeeAprPercent, 54.75));
  // No spot price supplied, so range membership is unknown rather than assumed.
  assert.equal(result.inRange, null);
});

test("projects when the spot price sits inside the range", () => {
  const result = projectConcentratedLiquidityFees({
    ...baseInput,
    currentPrice: 0.15,
  });

  assert.equal(result.inRange, true);
  assert.ok(closeTo(result.projectedFees24h, 15));
});

test("treats a price exactly on a range boundary as in range", () => {
  const atLower = projectConcentratedLiquidityFees({
    ...baseInput,
    currentPrice: baseInput.priceLower,
  });
  const atUpper = projectConcentratedLiquidityFees({
    ...baseInput,
    currentPrice: baseInput.priceUpper,
  });

  assert.equal(atLower.inRange, true);
  assert.equal(atUpper.inRange, true);
  assert.ok(closeTo(atLower.projectedFees24h, 15));
  assert.ok(closeTo(atUpper.projectedFees24h, 15));
});

test("returns a zero projection when the spot price has left the range", () => {
  const below = projectConcentratedLiquidityFees({
    ...baseInput,
    currentPrice: 0.05,
  });
  const above = projectConcentratedLiquidityFees({
    ...baseInput,
    currentPrice: 0.5,
  });

  for (const result of [below, above]) {
    assert.equal(result.inRange, false);
    assert.equal(result.projectedFees24h, 0);
    assert.equal(result.projectedFeesAnnualized, 0);
    assert.equal(result.projectedFeeAprPercent, 0);
    // The share is still reported so callers can show the position size.
    assert.ok(closeTo(result.liquidityShare, 0.01));
  }
});

test("rejects a non-positive liquidity denominator instead of dividing by zero", () => {
  assert.throws(
    () => projectConcentratedLiquidityFees({ ...baseInput, totalLiquidity: 0 }),
    FeeProjectionError,
  );
  assert.throws(
    () =>
      projectConcentratedLiquidityFees({
        ...baseInput,
        totalLiquidity: Number.POSITIVE_INFINITY,
      }),
    FeeProjectionError,
  );
});

test("rejects a target liquidity larger than the pool", () => {
  assert.throws(
    () =>
      projectConcentratedLiquidityFees({
        ...baseInput,
        liquidityAmount: baseInput.totalLiquidity + 1,
      }),
    /cannot exceed/,
  );
});

test("rejects an inverted or degenerate price range", () => {
  assert.throws(
    () =>
      projectConcentratedLiquidityFees({
        ...baseInput,
        priceLower: 0.2,
        priceUpper: 0.1,
      }),
    /strictly less/,
  );
  assert.throws(
    () =>
      projectConcentratedLiquidityFees({
        ...baseInput,
        priceLower: 0.1,
        priceUpper: 0.1,
      }),
    /strictly less/,
  );
});

test("rejects a fee tier outside the open interval (0, 1)", () => {
  for (const feeTier of [0, -0.001, 1, 1.5]) {
    assert.throws(
      () => projectConcentratedLiquidityFees({ ...baseInput, feeTier }),
      FeeProjectionError,
    );
  }
});

test("rejects a negative 24h volume", () => {
  assert.throws(
    () => projectConcentratedLiquidityFees({ ...baseInput, volume24h: -1 }),
    FeeProjectionError,
  );
});

test("exposes a 0.30% default fee tier for pools without history", () => {
  assert.equal(DEFAULT_FEE_TIER, 0.003);
});
