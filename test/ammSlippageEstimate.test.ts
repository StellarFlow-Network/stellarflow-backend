import request from "supertest";
import app from "../src/app";

describe("AMM slippage estimate", () => {
  it("returns a valid price-impact estimate for a healthy trade", async () => {
    const res = await request(app)
      .get("/api/v1/amm/slippage-estimate")
      .query({
        reserveIn: 1000,
        reserveOut: 2000,
        amountIn: 100,
        feeBps: 30,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.priceImpactPercent).toBeGreaterThan(0);
    expect(res.body.data.exceedsThreshold).toBe(false);
    expect(res.body.data.warning).toBe(false);
  });

  it("flags front-end clients when slippage exceeds the 3% threshold", async () => {
    const res = await request(app)
      .get("/api/v1/amm/slippage-estimate")
      .query({
        reserveIn: 100,
        reserveOut: 1000,
        amountIn: 50,
        feeBps: 30,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.exceedsThreshold).toBe(true);
    expect(res.body.data.warning).toBe(true);
    expect(res.body.data.priceImpactPercent).toBeGreaterThan(3);
  });
});
