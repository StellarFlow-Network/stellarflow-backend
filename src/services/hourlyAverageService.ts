import prisma from "../lib/prisma";

/**
 * HourlyAverageService
 * background job that calculates the average price of each currency for the preceding hour
 * and stores it in the HourlyStats table for cleaner charts.
 */
export class HourlyAverageService {
  private isRunning: boolean = false;
  private checkIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(checkIntervalMs: number = 15 * 60 * 1000) {
    // Every 15 minutes
    this.checkIntervalMs = checkIntervalMs;
  }

  /**
   * Start the background service.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("[HourlyAverageService] Service is already running");
      return;
    }

    this.isRunning = true;
    console.info(
      `[HourlyAverageService] Started with ${this.checkIntervalMs}ms check interval`,
    );

    // Run immediately on start
    await this.processMissingHourlyStats().catch((err) => {
      console.error("[HourlyAverageService] Initial processing error:", err);
    });

    // Start periodic checks
    this.timer = setInterval(() => {
      this.processMissingHourlyStats().catch((err) => {
        console.error("[HourlyAverageService] Background job error:", err);
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stop the background service.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.info("[HourlyAverageService] Stopped");
  }

  restart(newIntervalMs: number): void {
    if (!this.isRunning) return;
    if (newIntervalMs === this.checkIntervalMs) return;
    this.checkIntervalMs = newIntervalMs;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      this.processMissingHourlyStats().catch((err) => {
        console.error("[HourlyAverageService] Background job error:", err);
      });
    }, this.checkIntervalMs);
    console.info(`[HourlyAverageService] Check interval updated to ${this.checkIntervalMs}ms`);
  }

  /**
   * Main logic to find missing hourly stats and calculate them.
   * Checks the last 24 hours for any gaps.
   */
  private async processMissingHourlyStats(): Promise<void> {
    try {
      const now = new Date();
      // Start of the current hour
      const currentHourStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        now.getHours(),
      );

      // Get all active currencies
      const activeCurrencies = await prisma.currency.findMany({
        where: { isActive: true },
      });

      if (activeCurrencies.length === 0) {
        return;
      }

      // We look back at the last 24 hours
      for (let i = 1; i <= 24; i++) {
        const targetHour = new Date(
          currentHourStart.getTime() - i * 60 * 60 * 1000,
        );
        const nextHour = new Date(targetHour.getTime() + 60 * 60 * 1000);

        for (const currency of activeCurrencies) {
          // 1. Check if stats already exist for this hour
          const existing = await prisma.hourlyStats.findUnique({
            where: {
              currency_hour: {
                currency: currency.code,
                hour: targetHour,
              },
            },
          });

          if (existing) {
            continue; // Skip if already calculated
          }

          // 2. Calculate average from PriceHistory
          const aggregate = await prisma.priceHistory.aggregate({
            where: {
              currency: currency.code,
              timestamp: {
                gte: targetHour,
                lt: nextHour,
              },
            },
            _avg: {
              rate: true,
            },
          });

          if (aggregate._avg.rate) {
            // 3. Save the calculated average
            await prisma.hourlyStats.create({
              data: {
                currency: currency.code,
                hour: targetHour,
                averageRate: aggregate._avg.rate,
              },
            });

            console.info(
              `[HourlyAverageService] ✅ Calculated average for ${currency.code} at ${targetHour.toISOString()}: ${aggregate._avg.rate}`,
            );
          }
        }
      }
    } catch (error) {
      console.error(
        "[HourlyAverageService] Error processing hourly stats:",
        error,
      );
    }
  }

  /**
   * Get service status.
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      checkIntervalMs: this.checkIntervalMs,
    };
  }
}

// Export singleton instance
export const hourlyAverageService = new HourlyAverageService();
