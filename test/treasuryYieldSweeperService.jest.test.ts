import { jest } from "@jest/globals";
import {
  TreasuryClaimExecutor,
  ReserveLiquidityPoolRouter,
  TreasuryStakedAssetYieldSweeperBot,
  TreasuryStakedPosition,
  TreasurySweepRecord,
} from "../src/services/treasuryYieldSweeperService.js";

describe("TreasuryStakedAssetYieldSweeperBot", () => {
  function setup(
    positionOverrides: Partial<TreasuryStakedPosition> = {},
    claimThresholdUsd = 500,
  ) {
    const defaultPosition: TreasuryStakedPosition = {
      strategyId: "strategy-vault-usdc",
      vaultAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      asset: "USDC",
      stakedAmount: 50_000,
      uncollectedRewards: 600, // $600 value (> $500 threshold)
      rewardAssetPriceUsd: 1.0,
      reservePoolId: "pool_usdc_reserve",
      ...positionOverrides,
    };

    const claim_treasury_rewards = jest.fn<TreasuryClaimExecutor["claim_treasury_rewards"]>().mockResolvedValue({
      transactionHash: "tx-claim-123",
      claimedAmount: defaultPosition.uncollectedRewards,
    });

    const routeToReservePool = jest.fn<ReserveLiquidityPoolRouter["routeToReservePool"]>().mockResolvedValue({
      transactionHash: "tx-route-456",
      routedAmount: defaultPosition.uncollectedRewards,
      poolId: defaultPosition.reservePoolId ?? "pool_usdc_xlm_reserve",
    });

    const records: TreasurySweepRecord[] = [];
    const analytics = {
      recordSweep: async (record: TreasurySweepRecord) => {
        records.push(record);
      },
    };

    const bot = new TreasuryStakedAssetYieldSweeperBot(
      { getStakedPositions: async () => [defaultPosition] },
      { claim_treasury_rewards },
      { routeToReservePool },
      analytics,
      claimThresholdUsd,
    );

    return { bot, claim_treasury_rewards, routeToReservePool, records, defaultPosition };
  }

  it("triggers claim_treasury_rewards and routes to reserve pool when uncollected rewards exceed $500 USD", async () => {
    const { bot, claim_treasury_rewards, routeToReservePool, records } = setup({
      uncollectedRewards: 650, // $650 USD > $500 USD
      rewardAssetPriceUsd: 1.0,
    });

    const result = await bot.sweep();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      strategyId: "strategy-vault-usdc",
      status: "CLAIMED_AND_ROUTED",
      uncollectedRewards: 650,
      uncollectedUsdValue: 650,
      claimTransactionHash: "tx-claim-123",
      routeTransactionHash: "tx-route-456",
      reservePoolId: "pool_usdc_reserve",
    });

    // 1. Triggered claim_treasury_rewards
    expect(claim_treasury_rewards).toHaveBeenCalledTimes(1);
    expect(claim_treasury_rewards).toHaveBeenCalledWith(
      "strategy-vault-usdc",
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      650,
    );

    // 2. Routed claimed yield directly into protocol reserve liquidity pools
    expect(routeToReservePool).toHaveBeenCalledTimes(1);
    expect(routeToReservePool).toHaveBeenCalledWith(
      "pool_usdc_reserve",
      "USDC",
      650,
    );

    // 3. Recorded sweep audit record
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "CLAIMED_AND_ROUTED",
      claimThresholdUsd: 500,
      claimTransactionHash: "tx-claim-123",
      routeTransactionHash: "tx-route-456",
    });
  });

  it("skips claim and route when uncollected rewards are at or below $500 USD value", async () => {
    const { bot, claim_treasury_rewards, routeToReservePool, records } = setup({
      uncollectedRewards: 450, // $450 USD <= $500 USD
      rewardAssetPriceUsd: 1.0,
    });

    const result = await bot.sweep();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      status: "SKIPPED",
      uncollectedRewards: 450,
      uncollectedUsdValue: 450,
    });

    expect(claim_treasury_rewards).not.toHaveBeenCalled();
    expect(routeToReservePool).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      status: "SKIPPED",
      uncollectedUsdValue: 450,
    });
  });

  it("skips claim when uncollected rewards are exactly $500 USD (must exceed $500)", async () => {
    const { bot, claim_treasury_rewards, routeToReservePool } = setup({
      uncollectedRewards: 500,
      rewardAssetPriceUsd: 1.0,
    });

    const result = await bot.sweep();

    expect(result[0].status).toBe("SKIPPED");
    expect(claim_treasury_rewards).not.toHaveBeenCalled();
    expect(routeToReservePool).not.toHaveBeenCalled();
  });

  it("calculates USD value correctly for non-USDC assets with oracle prices", async () => {
    // 5,000 XLM at $0.12 = $600 USD (> $500 threshold)
    const { bot, claim_treasury_rewards, routeToReservePool } = setup({
      asset: "XLM",
      uncollectedRewards: 5000,
      rewardAssetPriceUsd: 0.12,
    });

    const result = await bot.sweep();

    expect(result[0]).toMatchObject({
      status: "CLAIMED_AND_ROUTED",
      uncollectedRewards: 5000,
      uncollectedUsdValue: 600,
    });
    expect(claim_treasury_rewards).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      5000,
    );
    expect(routeToReservePool).toHaveBeenCalledWith(
      expect.any(String),
      "XLM",
      5000,
    );
  });

  it("skips non-USDC asset when USD value is below threshold", async () => {
    // 3,000 XLM at $0.12 = $360 USD (< $500 threshold)
    const { bot, claim_treasury_rewards } = setup({
      asset: "XLM",
      uncollectedRewards: 3000,
      rewardAssetPriceUsd: 0.12,
    });

    const result = await bot.sweep();

    expect(result[0].status).toBe("SKIPPED");
    expect(result[0].uncollectedUsdValue).toBe(360);
    expect(claim_treasury_rewards).not.toHaveBeenCalled();
  });

  it("handles claim failure gracefully and isolates other positions", async () => {
    const failingClaim = jest.fn<TreasuryClaimExecutor["claim_treasury_rewards"]>().mockRejectedValue(new Error("RPC timeout"));
    const records: TreasurySweepRecord[] = [];

    const bot = new TreasuryStakedAssetYieldSweeperBot(
      {
        getStakedPositions: async () => [
          {
            strategyId: "failing-vault",
            vaultAddress: "CFAIL",
            asset: "USDC",
            stakedAmount: 10_000,
            uncollectedRewards: 800,
            rewardAssetPriceUsd: 1.0,
          },
          {
            strategyId: "small-vault",
            vaultAddress: "CSMALL",
            asset: "USDC",
            stakedAmount: 1_000,
            uncollectedRewards: 50,
            rewardAssetPriceUsd: 1.0,
          },
        ],
      },
      { claim_treasury_rewards: failingClaim },
      { routeToReservePool: jest.fn<ReserveLiquidityPoolRouter["routeToReservePool"]>() },
      { recordSweep: async (r) => { records.push(r); } },
      500,
    );

    const results = await bot.sweep();

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      strategyId: "failing-vault",
      status: "FAILED",
      error: "RPC timeout",
    });
    expect(results[1]).toMatchObject({
      strategyId: "small-vault",
      status: "SKIPPED",
    });
    expect(records.find((r) => r.status === "FAILED")?.error).toBe("RPC timeout");
  });

  it("prevents overlapping sweep cycles", async () => {
    let releasePromise: (() => void) | undefined;
    const bot = new TreasuryStakedAssetYieldSweeperBot(
      {
        getStakedPositions: () =>
          new Promise((resolve) => {
            releasePromise = () => resolve([]);
          }),
      },
      { claim_treasury_rewards: jest.fn<TreasuryClaimExecutor["claim_treasury_rewards"]>() },
      { routeToReservePool: jest.fn<ReserveLiquidityPoolRouter["routeToReservePool"]>() },
    );

    const firstRun = bot.sweep();
    const secondRun = await bot.sweep();

    expect(secondRun).toEqual([]);
    releasePromise?.();
    await expect(firstRun).resolves.toEqual([]);
  });

  it("throws validation error for invalid positions", async () => {
    const bot = new TreasuryStakedAssetYieldSweeperBot(
      {
        getStakedPositions: async () => [
          {
            strategyId: "",
            vaultAddress: "CV",
            asset: "USDC",
            stakedAmount: 100,
            uncollectedRewards: 10,
            rewardAssetPriceUsd: 1,
          },
        ],
      },
      { claim_treasury_rewards: jest.fn<TreasuryClaimExecutor["claim_treasury_rewards"]>() },
      { routeToReservePool: jest.fn<ReserveLiquidityPoolRouter["routeToReservePool"]>() },
    );

    await expect(bot.sweep()).rejects.toThrow("Treasury staked position requires strategyId");
  });
});
