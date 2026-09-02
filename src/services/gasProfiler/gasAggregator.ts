import type { GasDailyStats, GasMetrics, TxType } from "./gasMetrics.types";

/**
 * Daily cost rollups per transaction type (Issue #786).
 *
 * Kept free of Prisma so the arithmetic can be tested without a database; the
 * service layer supplies the rows and persists the result.
 */

/** Truncates to the start of the UTC day, so rollups do not shift with server timezone. */
export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function average(total: number, count: number): number {
  return count === 0 ? 0 : total / count;
}

/**
 * Groups samples by transaction type and reduces each group to daily averages.
 *
 * Fees are summed as `bigint` to avoid precision loss across a high-volume day,
 * then converted once for the average. Types are emitted in a stable
 * alphabetical order so output is deterministic.
 */
export function aggregateDailyStats(
  samples: readonly GasMetrics[],
  day: Date,
): GasDailyStats[] {
  const groups = new Map<TxType, GasMetrics[]>();

  for (const sample of samples) {
    const group = groups.get(sample.txType);
    if (group) {
      group.push(sample);
    } else {
      groups.set(sample.txType, [sample]);
    }
  }

  const normalizedDay = startOfUtcDay(day);

  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([txType, group]) => {
      const count = group.length;

      let cpuTotal = 0;
      let diskReadTotal = 0;
      let writeTotal = 0;
      let maxCpuInstructions = 0;
      let feeTotal = 0n;
      let rentTotal = 0n;

      for (const sample of group) {
        cpuTotal += sample.cpuInstructions;
        diskReadTotal += sample.diskReadBytes;
        writeTotal += sample.writeBytes;
        feeTotal += sample.feeChargedStroops;
        rentTotal += sample.rentFeeStroops;

        if (sample.cpuInstructions > maxCpuInstructions) {
          maxCpuInstructions = sample.cpuInstructions;
        }
      }

      return {
        day: normalizedDay,
        txType,
        sampleCount: count,
        avgCpuInstructions: average(cpuTotal, count),
        avgFeeChargedStroops: average(Number(feeTotal), count),
        avgRentFeeStroops: average(Number(rentTotal), count),
        avgDiskReadBytes: average(diskReadTotal, count),
        avgWriteBytes: average(writeTotal, count),
        maxCpuInstructions,
        totalFeeChargedStroops: feeTotal,
      };
    });
}

/** Converts stroops to XLM for human-facing output. 1 XLM = 10^7 stroops. */
export const STROOPS_PER_XLM = 10_000_000;

export function stroopsToXlm(stroops: bigint | number): number {
  return Number(stroops) / STROOPS_PER_XLM;
}
