import { describe, it, expect } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  CollateralFactorService,
  DEFAULT_COLLATERAL_FACTOR_CONFIG,
  computeCollateralFactor,
  computeLiquidityDepth,
  type LiquiditySample,
} from "../src/services/collateralFactorService";
import riskRouter from "../src/routes/risk";

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
});
