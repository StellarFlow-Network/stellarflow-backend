import { logger } from '../utils/logger';

export class ZScoreAnomalyFilter {
  // Store the sliding window of prices per asset
  private windows: Map<string, number[]> = new Map();
  private readonly maxWindowSize = 10;
  private readonly threshold = 3;

  /**
   * Process an incoming price update.
   * Returns true if the price is accepted, false if it is rejected as an anomaly.
   */
  public processPrice(asset: string, price: number): boolean {
    if (!this.windows.has(asset)) {
      this.windows.set(asset, []);
    }

    const window = this.windows.get(asset)!;

    // Need at least 2 prices to calculate a meaningful standard deviation
    if (window.length < 2) {
      this.updateWindow(window, price);
      return true;
    }

    const mean = this.calculateMean(window);
    const stdDev = this.calculateStdDev(window, mean);

    if (stdDev === 0) {
      // Handle the edge case where sigma = 0 (all prices in history are identical).
      // If the incoming price is identical to the history, accept it.
      // If it deviates, mathematically the Z-score is infinite, so we reject it as an anomaly.
      if (price !== mean) {
        logger.warn(`[Volatility Alert] Price anomaly detected for ${asset}. Price: ${price}, Mean: ${mean}, StdDev: 0`);
        return false;
      }

      this.updateWindow(window, price);
      return true;
    }

    const zScore = Math.abs(price - mean) / stdDev;

    if (zScore > this.threshold) {
      logger.warn(`[Volatility Alert] Price anomaly detected for ${asset}. Price: ${price}, Z-score: ${zScore.toFixed(2)}, Threshold: ${this.threshold}`);
      return false; // Discard
    }

    this.updateWindow(window, price);
    return true; // Proceed
  }

  private updateWindow(window: number[], price: number) {
    window.push(price);
    if (window.length > this.maxWindowSize) {
      window.shift(); // Remove oldest price to maintain window size
    }
  }

  private calculateMean(data: number[]): number {
    const sum = data.reduce((acc, val) => acc + val, 0);
    return sum / data.length;
  }

  private calculateStdDev(data: number[], mean: number): number {
    const squareDiffs = data.map(value => {
      const diff = value - mean;
      return diff * diff;
    });

    const avgSquareDiff = this.calculateMean(squareDiffs);
    return Math.sqrt(avgSquareDiff); // Sample population standard deviation
  }
}

// Export a singleton instance for shared usage across the application
export const zScoreAnomalyFilter = new ZScoreAnomalyFilter();
