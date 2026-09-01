/**
 * Issue #786 – daily cost rollups, transaction-type classification and
 * unexpected-spike detection.
 */
import { describe, it, expect } from "@jest/globals";

import {
  aggregateDailyStats,
  startOfUtcDay,
  stroopsToXlm,
} from "../src/services/gasProfiler/gasAggregator";
import type { GasMetrics } from "../src/services/gasProfiler/gasMetrics.types";
import {
  DEFAULT_MIN_BASELINE_SAMPLES,
  evaluateSpike,
  mean,
  resolveSpikeThresholds,
  standardDeviation,
  type SpikeThresholds,
} from "../src/services/gasProfiler/gasSpikeDetector";
import {
  classifyTxType,
  normalizeFunctionName,
  parseTxTypeAliases,
} from "../src/services/gasProfiler/txTypeClassifier";

function sample(overrides: Partial<GasMetrics> = {}): GasMetrics {
  return {
    txHash: "hash",
    txType: "swap",
    contractId: "C_CONTRACT",
    functionName: "swap",
    successful: true,
    cpuInstructions: 1_000_000,
    diskReadBytes: 1_000,
    writeBytes: 500,
    resourceFeeStroops: 10_000n,
    feeChargedStroops: 20_000n,
    nonRefundableFeeStroops: 8_000n,
    refundableFeeStroops: 2_000n,
    rentFeeStroops: 1_000n,
    ledgerSeq: 100,
    occurredAt: new Date("2026-03-04T10:00:00Z"),
    source: "backfill",
    ...overrides,
  };
}

const thresholds: SpikeThresholds = {
  percentThreshold: 50,
  zScoreThreshold: 3,
  minBaselineSamples: 5,
};

describe("normalizeFunctionName", () => {
  it.each([
    ["swap", "swap"],
    ["  Swap  ", "swap"],
    ["swapExactIn", "swap_exact_in"],
    ["swap-exact-in", "swap_exact_in"],
    ["SWAP_EXACT_IN", "swap_exact_in"],
    ["add liquidity", "add_liquidity"],
    ["__deposit__", "deposit"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeFunctionName(input)).toBe(expected);
  });

  it("returns null for empty or non-string input", () => {
    expect(normalizeFunctionName("")).toBeNull();
    expect(normalizeFunctionName("   ")).toBeNull();
    expect(normalizeFunctionName(undefined)).toBeNull();
    expect(normalizeFunctionName(123)).toBeNull();
  });
});

describe("classifyTxType", () => {
  it("maps the three tracked protocol types", () => {
    expect(classifyTxType("swap")).toBe("swap");
    expect(classifyTxType("deposit")).toBe("deposit");
    expect(classifyTxType("withdraw")).toBe("withdraw");
  });

  it("recognises common aliases", () => {
    expect(classifyTxType("add_liquidity")).toBe("deposit");
    expect(classifyTxType("remove_liquidity")).toBe("withdraw");
    expect(classifyTxType("swap_exact_out")).toBe("swap");
  });

  it("distinguishes an untracked call from an unreadable one", () => {
    // "other" means a contract call we do not track; "unknown" means no
    // function name was visible at all.
    expect(classifyTxType("harvest")).toBe("other");
    expect(classifyTxType(null)).toBe("unknown");
    expect(classifyTxType(undefined)).toBe("unknown");
  });

  it("lets overrides take precedence over built-in aliases", () => {
    expect(classifyTxType("mint", { mint: "swap" })).toBe("swap");
    expect(classifyTxType("mint")).toBe("deposit");
  });
});

describe("parseTxTypeAliases", () => {
  it("parses alias:type pairs", () => {
    expect(parseTxTypeAliases("settle:swap,top_up:deposit")).toEqual({
      settle: "swap",
      top_up: "deposit",
    });
  });

  it("normalizes both sides of the pair", () => {
    expect(parseTxTypeAliases("Settle Trade: SWAP")).toEqual({
      settle_trade: "swap",
    });
  });

  it("ignores entries targeting an untracked type", () => {
    expect(parseTxTypeAliases("foo:bar,settle:swap")).toEqual({
      settle: "swap",
    });
  });

  it("returns an empty map for unset or malformed input", () => {
    expect(parseTxTypeAliases(undefined)).toEqual({});
    expect(parseTxTypeAliases("")).toEqual({});
    expect(parseTxTypeAliases(",,:,")).toEqual({});
  });
});

describe("aggregateDailyStats", () => {
  it("computes per-type averages", () => {
    const stats = aggregateDailyStats(
      [
        sample({
          txType: "swap",
          cpuInstructions: 1_000,
          feeChargedStroops: 100n,
        }),
        sample({
          txType: "swap",
          cpuInstructions: 3_000,
          feeChargedStroops: 300n,
        }),
      ],
      new Date("2026-03-04T23:00:00Z"),
    );

    expect(stats).toHaveLength(1);
    expect(stats[0]!.txType).toBe("swap");
    expect(stats[0]!.sampleCount).toBe(2);
    expect(stats[0]!.avgCpuInstructions).toBe(2_000);
    expect(stats[0]!.avgFeeChargedStroops).toBe(200);
  });

  it("separates the tracked transaction types", () => {
    const stats = aggregateDailyStats(
      [
        sample({ txType: "swap", cpuInstructions: 1_000 }),
        sample({ txType: "deposit", cpuInstructions: 2_000 }),
        sample({ txType: "withdraw", cpuInstructions: 3_000 }),
      ],
      new Date("2026-03-04T00:00:00Z"),
    );

    expect(stats.map((s) => s.txType)).toEqual(["deposit", "swap", "withdraw"]);
    expect(stats.map((s) => s.avgCpuInstructions)).toEqual([
      2_000, 1_000, 3_000,
    ]);
  });

  it("tracks the peak instruction count and the fee total", () => {
    const stats = aggregateDailyStats(
      [
        sample({ cpuInstructions: 500, feeChargedStroops: 10n }),
        sample({ cpuInstructions: 9_000, feeChargedStroops: 90n }),
      ],
      new Date("2026-03-04T00:00:00Z"),
    );

    expect(stats[0]!.maxCpuInstructions).toBe(9_000);
    expect(stats[0]!.totalFeeChargedStroops).toBe(100n);
  });

  it("sums fees as bigint so a high-volume day loses no precision", () => {
    const big = 9_007_199_254_740_993n; // exceeds Number.MAX_SAFE_INTEGER
    const stats = aggregateDailyStats(
      [sample({ feeChargedStroops: big }), sample({ feeChargedStroops: big })],
      new Date("2026-03-04T00:00:00Z"),
    );

    expect(stats[0]!.totalFeeChargedStroops).toBe(big * 2n);
  });

  it("normalizes the day to the UTC boundary", () => {
    const stats = aggregateDailyStats(
      [sample()],
      new Date("2026-03-04T23:59:59Z"),
    );

    expect(stats[0]!.day.toISOString()).toBe("2026-03-04T00:00:00.000Z");
  });

  it("returns nothing for an empty sample set", () => {
    expect(aggregateDailyStats([], new Date())).toEqual([]);
  });
});

describe("startOfUtcDay", () => {
  it("truncates to midnight UTC regardless of time of day", () => {
    expect(
      startOfUtcDay(new Date("2026-03-04T18:45:12.345Z")).toISOString(),
    ).toBe("2026-03-04T00:00:00.000Z");
  });
});

describe("stroopsToXlm", () => {
  it("converts stroops to XLM", () => {
    expect(stroopsToXlm(10_000_000n)).toBe(1);
    expect(stroopsToXlm(1_500_000)).toBe(0.15);
  });
});

describe("mean and standardDeviation", () => {
  it("computes the mean", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBe(0);
  });

  it("computes the population standard deviation", () => {
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
    expect(standardDeviation([5, 5, 5])).toBe(0);
    expect(standardDeviation([])).toBe(0);
  });
});

describe("evaluateSpike", () => {
  const stableBaseline = [100, 102, 98, 101, 99, 100];

  it("flags a large jump above a stable baseline", () => {
    const result = evaluateSpike(
      "swap",
      "cpu",
      400,
      stableBaseline,
      thresholds,
    );

    expect(result.isSpike).toBe(true);
    expect(result.percentIncrease).toBeGreaterThan(50);
    expect(result.zScore).toBeGreaterThan(3);
  });

  it("ignores ordinary fluctuation", () => {
    const result = evaluateSpike(
      "swap",
      "cpu",
      103,
      stableBaseline,
      thresholds,
    );

    expect(result.isSpike).toBe(false);
    expect(result.reason).toContain("below the 50% threshold");
  });

  it("does not alert until the baseline has enough samples", () => {
    const result = evaluateSpike("swap", "cpu", 10_000, [100, 100], thresholds);

    expect(result.isSpike).toBe(false);
    expect(result.reason).toContain("2 of 5 required samples");
  });

  it("requires the z-score to agree, not just the percentage", () => {
    // A noisy baseline: +60% clears the percent gate but is well within normal
    // variance, so it must not alert.
    const noisy = [10, 200, 30, 180, 20, 190];
    const result = evaluateSpike(
      "swap",
      "cpu",
      Math.round(mean(noisy) * 1.6),
      noisy,
      thresholds,
    );

    expect(result.percentIncrease).toBeGreaterThan(50);
    expect(result.isSpike).toBe(false);
    expect(result.reason).toContain("z-score");
  });

  it("alerts on a flat baseline where the z-score is undefined", () => {
    // Zero variance makes the z-score meaningless, so the percentage test alone
    // must be able to fire; otherwise a perfectly stable metric never alerts.
    const result = evaluateSpike(
      "swap",
      "cpu",
      300,
      [100, 100, 100, 100, 100],
      thresholds,
    );

    expect(result.baselineStdDev).toBe(0);
    expect(result.isSpike).toBe(true);
  });

  it("does not alert when the baseline mean is zero", () => {
    const result = evaluateSpike(
      "swap",
      "cpu",
      500,
      [0, 0, 0, 0, 0],
      thresholds,
    );

    expect(result.isSpike).toBe(false);
    expect(result.reason).toBe("baseline mean is zero");
  });

  it("never treats a decrease as a spike", () => {
    const result = evaluateSpike("swap", "cpu", 10, stableBaseline, thresholds);

    expect(result.isSpike).toBe(false);
    expect(result.percentIncrease).toBeLessThan(0);
  });

  it("reports the context needed for an alert payload", () => {
    const result = evaluateSpike(
      "deposit",
      "feeCharged",
      400,
      stableBaseline,
      thresholds,
    );

    expect(result.txType).toBe("deposit");
    expect(result.metric).toBe("feeCharged");
    expect(result.baselineSampleCount).toBe(stableBaseline.length);
    expect(result.baselineMean).toBeCloseTo(100, 0);
  });
});

describe("resolveSpikeThresholds", () => {
  it("falls back to defaults when unset", () => {
    const resolved = resolveSpikeThresholds({});

    expect(resolved.percentThreshold).toBe(50);
    expect(resolved.zScoreThreshold).toBe(3);
    expect(resolved.minBaselineSamples).toBe(DEFAULT_MIN_BASELINE_SAMPLES);
  });

  it("honours overrides", () => {
    const resolved = resolveSpikeThresholds({
      GAS_SPIKE_PERCENT_THRESHOLD: "25",
      GAS_SPIKE_Z_SCORE_THRESHOLD: "2.5",
      GAS_SPIKE_MIN_BASELINE_SAMPLES: "10",
    });

    expect(resolved).toEqual({
      percentThreshold: 25,
      zScoreThreshold: 2.5,
      minBaselineSamples: 10,
    });
  });

  it("ignores non-numeric and non-positive overrides", () => {
    const resolved = resolveSpikeThresholds({
      GAS_SPIKE_PERCENT_THRESHOLD: "abc",
      GAS_SPIKE_Z_SCORE_THRESHOLD: "-1",
      GAS_SPIKE_MIN_BASELINE_SAMPLES: "0",
    });

    expect(resolved.percentThreshold).toBe(50);
    expect(resolved.zScoreThreshold).toBe(3);
    expect(resolved.minBaselineSamples).toBe(5);
  });
});
