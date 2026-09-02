import prisma from "../lib/prisma";
import { assetVolatility } from "../metrics";

export class VolatilityService {
  private static interval: NodeJS.Timeout | null = null;

  public static start() {
    if (this.interval) return;
    // Run every 5 minutes
    this.interval = setInterval(() => {
      this.calculateAndPushVolatility().catch(err => console.error("Volatility error:", err));
    }, 5 * 60 * 1000);
    this.calculateAndPushVolatility().catch(err => console.error("Volatility error:", err));
    console.log("📈 VolatilityService started");
  }

  public static stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Calculates the 24-hour rolling volatility for all active currencies
   * and pushes the metrics to Prometheus.
   */
  static async calculateAndPushVolatility() {
    try {
      const activeCurrencies = await prisma.currency.findMany({
        where: { isActive: true },
        select: { code: true },
      });

      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const results: Record<string, number> = {};

      for (const currency of activeCurrencies) {
        // Fetch price history for the last 24 hours
        const prices = await prisma.priceHistory.findMany({
          where: {
            currency: currency.code,
            timestamp: { gte: twentyFourHoursAgo },
          },
          select: { rate: true },
        });

        if (prices.length < 2) {
          // Not enough data to calculate standard deviation
          continue;
        }

        const rates = prices.map((p) => parseFloat(p.rate.toString()));
        const mean = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
        
        const squaredDiffs = rates.map((rate) => Math.pow(rate - mean, 2));
        const variance = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / (rates.length - 1);
        const stdDev = Math.sqrt(variance);

        // Calculate relative volatility as a percentage of the mean
        const volatilityIndex = (stdDev / mean) * 100;
        
        results[currency.code] = volatilityIndex;

        // Push to prometheus
        assetVolatility.labels(currency.code).set(volatilityIndex);
      }

      return results;
    } catch (error) {
      console.error("[VolatilityService] Error calculating volatility", error);
      throw error;
    }
  }
}
