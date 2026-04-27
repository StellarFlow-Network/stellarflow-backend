import prisma from "../lib/prisma";

export interface AnomalyCheckResult {
  isAnomalous: boolean;
  zScore: number;
  mean: number;
  stdDev: number;
  sampleSize: number;
}

export class AnomalyDetectionService {
  private readonly HISTORY_LIMIT = 50;
  private readonly MIN_SAMPLE_SIZE = 10;
  private readonly Z_SCORE_THRESHOLD = 3;

  /**
   * Calculates the Z-score for a given price update based on historical data.
   * Z = (x - mean) / stdDev
   */
  async checkAnomaly(
    currency: string,
    currentRate: number
  ): Promise<AnomalyCheckResult> {
    const history = await prisma.priceHistory.findMany({
      where: { currency: currency.toUpperCase() },
      orderBy: { timestamp: "desc" },
      take: this.HISTORY_LIMIT,
    });

    const rates = history.map((h) => Number(h.rate));
    const n = rates.length;

    if (n < this.MIN_SAMPLE_SIZE) {
      return {
        isAnomalous: false,
        zScore: 0,
        mean: 0,
        stdDev: 0,
        sampleSize: n,
      };
    }

    const mean = rates.reduce((a, b) => a + b, 0) / n;
    const variance =
      rates.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (n - 1);
    const stdDev = Math.sqrt(variance);

    // Handle edge case where stdDev is 0 (all historical rates are the same)
    if (stdDev === 0) {
      const isAnomalous = Math.abs(currentRate - mean) > 0;
      return {
        isAnomalous,
        zScore: isAnomalous ? Infinity : 0,
        mean,
        stdDev,
        sampleSize: n,
      };
    }

    const zScore = (currentRate - mean) / stdDev;
    const isAnomalous = Math.abs(zScore) > this.Z_SCORE_THRESHOLD;

    return {
      isAnomalous,
      zScore,
      mean,
      stdDev,
      sampleSize: n,
    };
  }
}

export const anomalyDetectionService = new AnomalyDetectionService();
