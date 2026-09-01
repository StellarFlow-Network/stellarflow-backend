import type { TxType } from "./gasMetrics.types";

/** Structural stand-in for `process.env`, so thresholds can be resolved from a plain object in tests. */
type EnvSource = Record<string, string | undefined>;

/**
 * Detects unexpected gas usage spikes (Issue #786).
 *
 * A spike is judged against a trailing baseline for the same transaction type,
 * because absolute cost varies enormously between a swap and a deposit. Two
 * independent signals are required to agree before alerting:
 *
 * - a relative increase over the baseline mean, and
 * - a z-score, so a type whose cost is naturally noisy does not alert on every
 *   ordinary fluctuation.
 *
 * Requiring both keeps a small, volatile sample from generating noise while
 * still catching a genuine step change.
 */

export const DEFAULT_SPIKE_PERCENT_THRESHOLD = 50;
export const DEFAULT_SPIKE_Z_SCORE_THRESHOLD = 3;
export const DEFAULT_MIN_BASELINE_SAMPLES = 5;

export interface SpikeThresholds {
  /** Percent increase over the baseline mean that counts as a spike. */
  percentThreshold: number;
  /** Standard deviations above the baseline mean that count as a spike. */
  zScoreThreshold: number;
  /** Baseline observations required before any alert can fire. */
  minBaselineSamples: number;
}

export interface SpikeEvaluation {
  txType: TxType;
  metric: string;
  isSpike: boolean;
  current: number;
  baselineMean: number;
  baselineStdDev: number;
  percentIncrease: number;
  zScore: number;
  baselineSampleCount: number;
  /** Why no alert fired, for logging. Undefined when `isSpike` is true. */
  reason?: string;
}

export function resolveSpikeThresholds(
  env: EnvSource = process.env,
): SpikeThresholds {
  const percent = Number.parseFloat(env.GAS_SPIKE_PERCENT_THRESHOLD ?? "");
  const zScore = Number.parseFloat(env.GAS_SPIKE_Z_SCORE_THRESHOLD ?? "");
  const minSamples = Number.parseInt(
    env.GAS_SPIKE_MIN_BASELINE_SAMPLES ?? "",
    10,
  );

  return {
    percentThreshold:
      Number.isFinite(percent) && percent > 0
        ? percent
        : DEFAULT_SPIKE_PERCENT_THRESHOLD,
    zScoreThreshold:
      Number.isFinite(zScore) && zScore > 0
        ? zScore
        : DEFAULT_SPIKE_Z_SCORE_THRESHOLD,
    minBaselineSamples:
      Number.isFinite(minSamples) && minSamples > 0
        ? minSamples
        : DEFAULT_MIN_BASELINE_SAMPLES,
  };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Population standard deviation; the baseline is the full set we compare against. */
export function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;

  const average = mean(values);
  const variance =
    values.reduce((total, value) => total + (value - average) ** 2, 0) /
    values.length;

  return Math.sqrt(variance);
}

/**
 * Compares a current reading against a trailing baseline.
 *
 * When the baseline has no variance (every observation identical), the z-score
 * is undefined, so the percentage test alone decides. Without that special case
 * a perfectly stable metric could never alert, since dividing by a zero standard
 * deviation yields Infinity or NaN.
 */
export function evaluateSpike(
  txType: TxType,
  metric: string,
  current: number,
  baseline: readonly number[],
  thresholds: SpikeThresholds,
): SpikeEvaluation {
  const baselineMean = mean(baseline);
  const baselineStdDev = standardDeviation(baseline);

  const percentIncrease =
    baselineMean > 0 ? ((current - baselineMean) / baselineMean) * 100 : 0;
  const zScore =
    baselineStdDev > 0 ? (current - baselineMean) / baselineStdDev : 0;

  const result: SpikeEvaluation = {
    txType,
    metric,
    isSpike: false,
    current,
    baselineMean,
    baselineStdDev,
    percentIncrease,
    zScore,
    baselineSampleCount: baseline.length,
  };

  if (baseline.length < thresholds.minBaselineSamples) {
    return {
      ...result,
      reason: `baseline has ${baseline.length} of ${thresholds.minBaselineSamples} required samples`,
    };
  }

  if (baselineMean <= 0) {
    return { ...result, reason: "baseline mean is zero" };
  }

  if (percentIncrease < thresholds.percentThreshold) {
    return {
      ...result,
      reason: `increase of ${percentIncrease.toFixed(1)}% is below the ${thresholds.percentThreshold}% threshold`,
    };
  }

  // A flat baseline gives no usable z-score, so the percentage test stands alone.
  if (baselineStdDev === 0) {
    return { ...result, isSpike: true };
  }

  if (zScore < thresholds.zScoreThreshold) {
    return {
      ...result,
      reason: `z-score of ${zScore.toFixed(2)} is below the ${thresholds.zScoreThreshold} threshold`,
    };
  }

  return { ...result, isSpike: true };
}
