import test from "node:test";
import assert from "node:assert/strict";
import { LiquidationFeeBumpEngine } from "../src/services/liquidationFeeBumpEngine.ts";

test("raises the fee by 25% when it remains within the profit cap", () => {
  const engine = new LiquidationFeeBumpEngine();
  assert.equal(
    engine.quote({ competingFeeStroops: 800, estimatedProfitStroops: 20_000 }),
    1_000,
  );
});

test("caps a replacement fee at ten percent of liquidation profit", () => {
  const engine = new LiquidationFeeBumpEngine();
  assert.equal(
    engine.quote({ competingFeeStroops: 20_000, estimatedProfitStroops: 50_000 }),
    5_000,
  );
});

test("rejects invalid fee or profit input", () => {
  const engine = new LiquidationFeeBumpEngine();
  assert.throws(() =>
    engine.quote({ competingFeeStroops: -1, estimatedProfitStroops: 10_000 }),
  );
  assert.throws(() =>
    engine.quote({ competingFeeStroops: 100, estimatedProfitStroops: 0 }),
  );
});
