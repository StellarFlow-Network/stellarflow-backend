import cron from "node-cron";
import type { ScheduledTask } from "node-cron";

import { getGasProfilerService } from "../services/gasProfiler/gasProfilerService";
import { logger } from "../utils/logger";

/**
 * Schedules the daily gas cost rollup (Issue #786).
 *
 * Runs shortly after midnight UTC and aggregates the day that just closed, so
 * the window is complete. Aggregating the current day would produce a partial
 * average and could trip the spike detector against a full-day baseline.
 */
export class GasProfileScheduler {
  private tasks: ScheduledTask[] = [];

  /** Aggregates the previous UTC day. */
  async runDailyRollup(now: Date = new Date()): Promise<void> {
    const previousDay = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    try {
      await getGasProfilerService().runDailyAggregation(previousDay);
    } catch (error) {
      logger.error("[GasProfileScheduler] Daily rollup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  start(): void {
    if (this.tasks.length > 0) {
      logger.warn("[GasProfileScheduler] Already started");
      return;
    }

    // 00:15 UTC daily — a small offset lets any in-flight backfill for the
    // closing day land before the rollup reads it.
    this.tasks.push(
      cron.schedule("15 0 * * *", () => void this.runDailyRollup(), {
        timezone: "UTC",
      }),
    );

    logger.info(
      "[GasProfileScheduler] Daily gas rollup scheduled for 00:15 UTC",
    );
  }

  stop(): void {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
    logger.info("[GasProfileScheduler] Stopped");
  }
}

export const gasProfileScheduler = new GasProfileScheduler();
