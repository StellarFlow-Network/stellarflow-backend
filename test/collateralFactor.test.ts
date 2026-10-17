process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import request from "supertest";
import {
  CollateralFactorService,
  DEFAULT_COLLATERAL_FACTOR_CONFIG,
  computeCollateralFactor,
  computeLiquidityDepth,
  type LiquiditySample,
  collateralFactorService,
} from "../src/services/collateralFactorService";
import {
  startCollateralFactorJob,
  stopCollateralFactorJob,
  runCollateralFactorJob,
  isCollateralFactorJobRunning,
  getScheduledCollateralFactorJob,
} from "../src/jobs/collateralFactorJob";
import riskRouter from "../src/routes/risk";
import { logger } from "../src/utils/logger";

const NOW = new Date("2026-09-29T00:00:00.000Z");

function samples(liquidity: number): LiquiditySample[] {
  return [{ timestamp: new Date("2026-09-28T00:00:00.000Z"), liquidity }];
}

test("CollateralFactor: computes mean liquidity depth across 7-day samples", { timeout: 15000 }, () => {
  const depth = computeLiquidityDepth([
    { timestamp: NOW, liquidity: 200_000 },
    { timestamp: NOW, liquidity: 400_000 },
    { timestamp: NOW, liquidity: 600_000 },
  ]);
  assert.equal(depth, 400_000);
  assert.equal(computeLiquidityDepth([]), 0);
});

test("CollateralFactor: applies base factor when liquidity is at or above reference", { timeout: 15000 }, () => {
  const result = computeCollateralFactor(
    "XLM",
    samples(1_500_000),
    DEFAULT_COLLATERAL_FACTOR_CONFIG,
    NOW,
  );
  assert.equal(result.asset, "XLM");
  assert.equal(result.valuationFactor, 0.95);
  assert.equal(result.belowThreshold, false);
  assert.equal(result.penaltyApplied, false);
});

test("CollateralFactor: reduces valuation factor automatically if market liquidity degrades", { timeout: 15000 }, () => {
  const degraded = computeCollateralFactor(
    "USDC",
    samples(120_000), // well below threshold 250_000
    DEFAULT_COLLATERAL_FACTOR_CONFIG,
    NOW,
    0.95, // previous factor was 0.95
  );

  assert.equal(degraded.belowThreshold, true);
  assert.equal(degraded.penaltyApplied, true);
  assert.equal(degraded.valuationFactor, 0.5); // minimum factor
  assert.equal(degraded.previousValuationFactor, 0.95);
  assert.equal(degraded.factorAdjustment, -0.45);
});

test("CollateralFactor: scales factor linearly with depth above threshold", { timeout: 15000 }, () => {
  const result = computeCollateralFactor(
    "NGN",
    samples(800_000),
    DEFAULT_COLLATERAL_FACTOR_CONFIG,
    NOW,
  );
  assert.equal(result.valuationFactor, 0.76);
  assert.equal(result.belowThreshold, false);
});

test("CollateralFactor: enforces configured floor regardless of zero liquidity", { timeout: 15000 }, () => {
  const result = computeCollateralFactor(
    "GHS",
    samples(0),
    DEFAULT_COLLATERAL_FACTOR_CONFIG,
    NOW,
  );
  assert.equal(result.valuationFactor, DEFAULT_COLLATERAL_FACTOR_CONFIG.minimumFactor);
  assert.equal(result.belowThreshold, true);
});

test("CollateralFactor: 24-hour factor calculation cycle logs adjustments and updates cache", { timeout: 20000 }, async () => {
  const service = new CollateralFactorService();
  const report = await service.calculateAndLogAdjustments({
    now: NOW,
    loadSamples: async (asset) =>
      asset === "USDC" ? samples(50_000) : samples(1_200_000),
  });

  assert.ok(report.assets.length >= 5);
  const usdc = report.assets.find((a) => a.asset === "USDC");
  const xlm = report.assets.find((a) => a.asset === "XLM");

  assert.equal(usdc?.belowThreshold, true);
  assert.equal(usdc?.penaltyApplied, true);
  assert.equal(xlm?.valuationFactor, 0.95);

  const active = service.getActiveCollateralFactors(["USDC", "XLM"]);
  assert.equal(active.assets.length, 2);
});

test("CollateralFactor: endpoint GET /api/v1/risk/collateral-factors responds in < 15ms", { timeout: 15000 }, async () => {
  const app = express();
  app.use("/api/v1/risk", riskRouter);

  // Warm pipeline
  await request(app).get("/api/v1/risk/collateral-factors?assets=XLM");

  const start = performance.now();
  const res = await request(app).get("/api/v1/risk/collateral-factors?assets=XLM,USDC");
  const duration = performance.now() - start;

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.assets.length, 2);
  assert.ok(duration < 15, `Expected response time < 15ms, got ${duration}ms`);
});

test("CollateralFactorJob: schedules, executes, and cleans up 24-hour job", { timeout: 20000 }, async () => {
  stopCollateralFactorJob();
  const task = startCollateralFactorJob("0 0 * * *");
  assert.ok(task);
  assert.notEqual(getScheduledCollateralFactorJob(), null);

  const report = await runCollateralFactorJob(NOW);
  assert.ok(report.assets.length >= 5);
  assert.equal(isCollateralFactorJobRunning(), false);

  stopCollateralFactorJob();
  assert.equal(getScheduledCollateralFactorJob(), null);
});
