import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  CollateralFactorService,
  DEFAULT_COLLATERAL_FACTOR_CONFIG,
  computeCollateralFactor,
  computeLiquidityDepth,
  type LiquiditySample,
  type CollateralFactorReport,
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

jest.setTimeout(30000);

const NOW = new Date("2026-09-29T00:00:00.000Z");

function samples(liquidity: number): LiquiditySample[] {
  return [{ timestamp: new Date("2026-09-28T00:00:00.000Z"), liquidity }];
}

describe("CollateralFactorService (Issue #1003)", () => {
  it("computes mean liquidity depth across samples", () => {
    expect(
      computeLiquidityDepth([
        { timestamp: NOW, liquidity: 100 },
        { timestamp: NOW, liquidity: 300 },
      ]),
    ).toBe(200);
    expect(computeLiquidityDepth([])).toBe(0);
  });

  it("applies the base factor when liquidity is at or above the reference", () => {
    const result = computeCollateralFactor(
      "xlm",
      samples(2_000_000),
      DEFAULT_COLLATERAL_FACTOR_CONFIG,
      NOW,
    );
    expect(result.asset).toBe("XLM");
    expect(result.valuationFactor).toBe(0.95);
    expect(result.belowThreshold).toBe(false);
    expect(result.penaltyApplied).toBe(false);
  });

  it("scales the factor linearly with depth above the threshold", () => {
    const result = computeCollateralFactor(
      "NGN",
      samples(800_000),
      DEFAULT_COLLATERAL_FACTOR_CONFIG,
      NOW,
    );
    expect(result.valuationFactor).toBeCloseTo(0.76, 6);
    expect(result.belowThreshold).toBe(false);
  });

  it("reduces the factor and flags illiquidity below the threshold", () => {
    const result = computeCollateralFactor(
      "USDC",
      samples(100_000),
      DEFAULT_COLLATERAL_FACTOR_CONFIG,
      NOW,
    );
    expect(result.belowThreshold).toBe(true);
    expect(result.penaltyApplied).toBe(true);
    expect(result.valuationFactor).toBe(DEFAULT_COLLATERAL_FACTOR_CONFIG.minimumFactor);
  });

  it("never drops the factor below the configured floor", () => {
    const result = computeCollateralFactor(
      "GHS",
      samples(0),
      DEFAULT_COLLATERAL_FACTOR_CONFIG,
      NOW,
    );
    expect(result.valuationFactor).toBe(DEFAULT_COLLATERAL_FACTOR_CONFIG.minimumFactor);
  });

  it("builds a per-asset report through an injected liquidity loader", async () => {
    const service = new CollateralFactorService();
    const report = await service.getCollateralFactors({
      assets: ["XLM", "USDC"],
      now: NOW,
      loadSamples: async (asset) =>
        asset === "USDC" ? samples(50_000) : samples(2_000_000),
    });

    expect(report.assets).toHaveLength(2);
    const xlm = report.assets.find((entry) => entry.asset === "XLM");
    const usdc = report.assets.find((entry) => entry.asset === "USDC");
    expect(xlm?.valuationFactor).toBe(0.95);
    expect(usdc?.penaltyApplied).toBe(true);
    expect(report.windowStart).toBe("2026-09-22T00:00:00.000Z");
  });

  it("serves GET /api/v1/risk/collateral-factors", async () => {
    const app = express();
    app.use("/api/v1/risk", riskRouter);

    const response = await request(app).get(
      "/api/v1/risk/collateral-factors?assets=XLM",
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.assets).toHaveLength(1);
    expect(response.body.data.assets[0].asset).toBe("XLM");
  });

  it("responds with active collateral factors in under 15ms (Acceptance Criteria)", async () => {
    const app = express();
    app.use("/api/v1/risk", riskRouter);

    // Warm HTTP pipeline so Node server setup does not skew timing
    await request(app).get("/api/v1/risk/collateral-factors?assets=XLM");

    // Measure active response time
    const start = performance.now();
    const response = await request(app).get(
      "/api/v1/risk/collateral-factors?assets=XLM,USDC",
    );
    const elapsedMs = performance.now() - start;

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.assets).toHaveLength(2);
    expect(elapsedMs).toBeLessThan(15);
  });

  it("returns active risk parameters for all supported collateral assets when query is empty", async () => {
    const app = express();
    app.use("/api/v1/risk", riskRouter);

    const response = await request(app).get("/api/v1/risk/collateral-factors");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.assets.length).toBeGreaterThanOrEqual(5);

    const assetSymbols = response.body.data.assets.map((a: any) => a.asset);
    expect(assetSymbols).toContain("XLM");
    expect(assetSymbols).toContain("USDC");
    expect(assetSymbols).toContain("NGN");
    expect(assetSymbols).toContain("GHS");
    expect(assetSymbols).toContain("KES");

    // Verify presence of full risk parameters
    const xlm = response.body.data.assets.find((a: any) => a.asset === "XLM");
    expect(xlm).toHaveProperty("baseFactor");
    expect(xlm).toHaveProperty("valuationFactor");
    expect(xlm).toHaveProperty("liquidityDepth7d");
    expect(xlm).toHaveProperty("liquidityThreshold");
    expect(xlm).toHaveProperty("referenceLiquidityDepth");
    expect(xlm).toHaveProperty("belowThreshold");
    expect(xlm).toHaveProperty("penaltyApplied");
  });

  it("calculates and logs factor adjustments automatically every 24 hours", async () => {
    const loggerInfoSpy = jest.spyOn(logger, "info");
    const loggerWarnSpy = jest.spyOn(logger, "warn");

    const service = new CollateralFactorService();

    // Baseline calculation
    await service.calculateAndLogAdjustments({
      now: NOW,
      loadSamples: async () => samples(1_000_000),
    });

    // 24 hours later: simulate market liquidity degradation on USDC and NGN
    const nextDay = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const report = await service.calculateAndLogAdjustments({
      now: nextDay,
      loadSamples: async (asset) => {
        if (asset === "USDC") return samples(100_000); // severely illiquid -> below threshold
        if (asset === "NGN") return samples(500_000);  // reduced liquidity
        return samples(1_500_000);
      },
    });

    expect(report.assets.length).toBeGreaterThanOrEqual(5);
    const usdc = report.assets.find((a) => a.asset === "USDC");
    const ngn = report.assets.find((a) => a.asset === "NGN");
    const xlm = report.assets.find((a) => a.asset === "XLM");

    // USDC degraded below threshold: factor reduced and penalty applied
    expect(usdc?.belowThreshold).toBe(true);
    expect(usdc?.penaltyApplied).toBe(true);
    expect(usdc?.valuationFactor).toBe(0.5);
    expect(usdc?.previousValuationFactor).toBe(0.95);
    expect(usdc?.factorAdjustment).toBe(-0.45);

    // NGN partially reduced
    expect(ngn?.belowThreshold).toBe(false);
    expect(ngn?.valuationFactor).toBeLessThan(0.95);
    expect(ngn?.previousValuationFactor).toBe(0.95);

    // XLM healthy at base factor
    expect(xlm?.valuationFactor).toBe(0.95);

    // Verify automatic logging occurred
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining("[CollateralFactorService] Factor adjustment for USDC"),
    );
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[CollateralFactorService] Market liquidity degradation detected for collateral asset USDC"),
    );
    expect(loggerInfoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Automatic 24-hour factor calculation completed"),
    );

    loggerInfoSpy.mockRestore();
    loggerWarnSpy.mockRestore();
  });

  it("manages the 24-hour scheduled collateral factor job lifecycle", async () => {
    stopCollateralFactorJob();
    expect(getScheduledCollateralFactorJob()).toBeNull();

    // Start scheduled job
    const task = startCollateralFactorJob();
    expect(task).toBeDefined();
    expect(getScheduledCollateralFactorJob()).not.toBeNull();

    // Execute job manually and verify execution
    const report = await runCollateralFactorJob(NOW);
    expect(report).toBeDefined();
    expect(report.assets.length).toBeGreaterThanOrEqual(5);
    expect(isCollateralFactorJobRunning()).toBe(false);

    // Clean up
    stopCollateralFactorJob();
    expect(getScheduledCollateralFactorJob()).toBeNull();
  });

  it("handles unknown collateral asset safely without throwing", async () => {
    const app = express();
    app.use("/api/v1/risk", riskRouter);

    const response = await request(app).get(
      "/api/v1/risk/collateral-factors?assets=UNKNOWN_TOKEN",
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.assets).toHaveLength(1);
    expect(response.body.data.assets[0].asset).toBe("UNKNOWN_TOKEN");
  });

  it("supports force refresh query parameter", async () => {
    const app = express();
    app.use("/api/v1/risk", riskRouter);

    const response = await request(app).get(
      "/api/v1/risk/collateral-factors?assets=XLM&refresh=true",
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.assets[0].asset).toBe("XLM");
  });
});
