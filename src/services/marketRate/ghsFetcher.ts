import axios from "axios";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../../utils/httpTimeout";
import { MarketRateFetcher, MarketRate } from "./types";
import { withRetry } from "../../utils/retryUtil";
import { createFetcherLogger } from "../../utils/logger";

/**
 * GHS/XLM rate fetcher using CoinGecko as primary source.
 */
export class GHSRateFetcher implements MarketRateFetcher {
  private readonly coinGeckoUrl =
    "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=ghs&include_last_updated_at=true";
  private logger = createFetcherLogger("GHSRate");

  getCurrency(): string {
    return "GHS";
  }

  async fetchRate(): Promise<MarketRate> {
    try {
      const response = await withRetry(
        () =>
          axios.get(this.coinGeckoUrl, {
            timeout: OUTGOING_HTTP_TIMEOUT_MS,
            headers: {
              "User-Agent": "StellarFlow-Oracle/1.0",
            },
          }),
        { maxRetries: 3, retryDelay: 1000 },
      );

      const stellarPrice = response.data.stellar;
      if (
        stellarPrice &&
        typeof stellarPrice.ghs === "number" &&
        stellarPrice.ghs > 0
      ) {
        const lastUpdatedAt = stellarPrice.last_updated_at
          ? new Date(stellarPrice.last_updated_at * 1000)
          : new Date();

        return {
          currency: "GHS",
          rate: stellarPrice.ghs,
          timestamp: lastUpdatedAt,
          source: "CoinGecko (GHS)",
        };
      }

      throw new Error("Invalid response from CoinGecko for GHS");
    } catch (error) {
      this.logger.error(
        "Failed to fetch GHS rate",
        undefined,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const rate = await this.fetchRate();
      return rate.rate > 0;
    } catch {
      return false;
    }
  }
}
