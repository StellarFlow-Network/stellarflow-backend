import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import {
  collateralFactorService,
  type CollateralFactorReport,
} from "../services/collateralFactorService";
import { logger } from "../utils/logger";

/**
 * Issue #1003 – 24-Hour Dynamic Vault Collateral Valuation Factor Calculation Job.
 *
 * Runs automatically every 24 hours to recalculate rolling 7-day liquidity depth
 * and dynamic collateral valuation factors (M_i) for all supported collateral assets.
 * Automatically logs factor adjustments and liquidity degradation alerts, and
 * updates active parameters in cache so the API endpoint responds in < 15ms.
 */

let scheduledTask: ScheduledTask | null = null;
let isJobRunning = false;

/**
 * Runs the 24-hour collateral factor calculation and adjustment cycle.
 * Calculates rolling 7-day liquidity depth, updates factors M_i, logs adjustments,
 * and refreshes the active cache.
 */
export async function runCollateralFactorJob(
  now: Date = new Date(),
): Promise<CollateralFactorReport> {
  if (isJobRunning) {
    logger.warn(
      "[CollateralFactorJob] Job already running, skipping overlapping execution",
    );
    return collateralFactorService.getActiveCollateralFactors();
  }

  isJobRunning = true;
  const startTime = Date.now();

  try {
    logger.info(
      "[CollateralFactorJob] Starting 24-hour collateral factor calculation and adjustment cycle...",
    );
    const report = await collateralFactorService.calculateAndLogAdjustments({
      now,
    });
    const duration = Date.now() - startTime;
    logger.info(
      `[CollateralFactorJob] Completed 24-hour collateral factor calculation in ${duration}ms for ${report.assets.length} assets`,
    );
    return report;
  } catch (error) {
    logger.error(
      "[CollateralFactorJob] Failed 24-hour collateral factor adjustment calculation",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    throw error;
  } finally {
    isJobRunning = false;
  }
}

/**
 * Starts the scheduled 24-hour collateral factor calculation job.
 * Default schedule: "0 0 * * *" (daily at 00:00 UTC).
 */
export function startCollateralFactorJob(
  cronExpression?: string,
): ScheduledTask {
  const schedule =
    cronExpression ||
    process.env.COLLATERAL_FACTOR_CRON_SCHEDULE ||
    "0 0 * * *";

  if (scheduledTask) {
    logger.warn(
      "[CollateralFactorJob] Job already scheduled, stopping previous task",
    );
    scheduledTask.stop();
  }

  logger.info(
    `[CollateralFactorJob] Scheduling 24-hour collateral factor job with cron: "${schedule}" (UTC)`,
  );

  scheduledTask = cron.schedule(
    schedule,
    async () => {
      try {
        await runCollateralFactorJob();
      } catch (err) {
        logger.error("[CollateralFactorJob] Scheduled run failed:", err);
      }
    },
    {
      timezone: "UTC",
      scheduled: true,
    },
  );

  return scheduledTask;
}

/**
 * Stops the scheduled 24-hour collateral factor job.
 */
export function stopCollateralFactorJob(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    logger.info("[CollateralFactorJob] Stopped scheduled job");
  }
}

/**
 * Returns whether the 24-hour calculation job is currently executing.
 */
export function isCollateralFactorJobRunning(): boolean {
  return isJobRunning;
}

/**
 * Returns the active ScheduledTask instance, if any.
 */
export function getScheduledCollateralFactorJob(): ScheduledTask | null {
  return scheduledTask;
}
