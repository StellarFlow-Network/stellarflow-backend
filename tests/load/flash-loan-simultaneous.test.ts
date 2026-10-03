import assert from "node:assert/strict";
import test from "node:test";
import { assessFlashLoanRisk, summarizeFlashLoanVolume } from "../../src/services/liquidity/calculation";

test("simulates 50 same-ledger flash loans with no pool loss or unhandled reverts", async () => {
  const initialLiquidity = 1_000_000;
  const events = await Promise.all(
    Array.from({ length: 50 }, async (_, index) => {
      await Promise.resolve();
      const principal = 10_000 + index;
      return {
        txHash: `flash-${index}`,
        ledger: 42,
        poolKey: "pool-1",
        amount: principal,
        poolLiquidityBefore: initialLiquidity,
        poolLiquidityAfter: initialLiquidity + Math.ceil(principal * 0.001),
        repaid: true,
      };
    }),
  );

  const assessments = events.map((event) => assessFlashLoanRisk(event));
  const summary = summarizeFlashLoanVolume(events);
  assert.equal(assessments.filter((assessment) => assessment.isManipulationRisk).length, 0);
  assert.equal(summary.eventCount, 50);
  assert.equal(summary.flaggedCount, 0);
  assert.equal(summary.unrepaidCount, 0);
  assert.equal(summary.byPool["pool-1"]?.events, 50);
  assert.ok(events.every((event) => event.poolLiquidityAfter >= initialLiquidity));
});