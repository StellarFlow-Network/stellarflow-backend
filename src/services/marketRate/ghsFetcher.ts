import axios from "axios";
import { MarketRateFetcher, MarketRate, calculateMedian, filterOutliers, SourceTrustLevel, calculateWeightedAverage } from "./types";
import logger from "../../utils/logger";
import { errorTracker } from "../errorTracker";
import { webhookService } from "../webhook";

type CoinGeckoPriceResponse = {
  stellar?: {
    ghs?: number;
    usd?: number;
    last_updated_at?: number;
  };
};

type ExchangeRateApiResponse = {
  result?: string;
  rates?: {
    GHS?: number;
  };
  time_last_update_unix?: number;
};

import { OUTGOING_HTTP_TIMEOUT_MS } from "../../utils/httpTimeout";
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
    } catch (error) {
      logger.debug("CoinGecko direct GHS price failed");
    }

    // Strategy 2: CoinGecko XLM/USD + ExchangeRate API
    try {
      const coinGeckoResponse = await axios.get<CoinGeckoPriceResponse>(
        this.coinGeckoUrl,
        {
          timeout: 10000,
          headers: {
            "User-Agent": "StellarFlow-Oracle/1.0",
          },
        },
      );

      const stellarPrice = coinGeckoResponse.data.stellar;
      if (
        stellarPrice &&
        typeof stellarPrice.usd === "number" &&
        stellarPrice.usd > 0
      ) {
        const exchangeRateResponse = await axios.get<ExchangeRateApiResponse>(
          this.usdToGhsUrl,
          {
            timeout: 10000,
            headers: {
              "User-Agent": "StellarFlow-Oracle/1.0",
            },
          },
        );

        const usdToGhsRate = exchangeRateResponse.data.rates?.GHS;
        if (
          exchangeRateResponse.data.result === "success" &&
          typeof usdToGhsRate === "number" &&
          usdToGhsRate > 0
        ) {
          const fxTimestamp = exchangeRateResponse.data.time_last_update_unix
            ? new Date(exchangeRateResponse.data.time_last_update_unix * 1000)
            : new Date();
          const lastUpdatedAt = stellarPrice.last_updated_at
            ? new Date(stellarPrice.last_updated_at * 1000)
            : new Date();

          prices.push({
            rate: stellarPrice.usd * usdToGhsRate,
            timestamp:
              fxTimestamp > lastUpdatedAt ? fxTimestamp : lastUpdatedAt,
            source: "CoinGecko + ExchangeRate API",
            trustLevel: "trusted",
          });
          
          // Success - reset error tracker
          errorTracker.trackSuccess("GHS-price-fetch");
        }
      }
    } catch (error) {
      logger.debug("CoinGecko + ExchangeRate API failed");
    }

    // Strategy 3: Try alternative XLM pricing source
    try {
      const alternativeUrl =
        "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd";
      const altResponse = await axios.get(alternativeUrl, {
        timeout: 10000,
        headers: {
          "User-Agent": "StellarFlow-Oracle/1.0",
        },
      });

      if (altResponse.data?.stellar?.usd) {
        const xlmUsd = parseFloat(altResponse.data.stellar.usd);
        if (!isNaN(xlmUsd) && xlmUsd > 0) {
          const ghsResponse = await axios.get<ExchangeRateApiResponse>(
            this.usdToGhsUrl,
            {
              timeout: 10000,
              headers: {
                "User-Agent": "StellarFlow-Oracle/1.0",
              },
            },
          );

          const ghsRate = ghsResponse.data.rates?.GHS;
          if (
            ghsResponse.data.result === "success" &&
            typeof ghsRate === "number" &&
            ghsRate > 0
          ) {
            prices.push({
              rate: xlmUsd * ghsRate,
              timestamp: new Date(),
              source: "Alternative XLM pricing",
              trustLevel: "new",
            });
            
            // Success - reset error tracker
            errorTracker.trackSuccess("GHS-price-fetch");
          }
        }
      }
    } catch (error) {
      logger.debug("Alternative XLM pricing source failed");
    }

    // If we have prices, calculate median
    if (prices.length > 0) {
      let rateValues = prices.map((p) => p.rate).filter(p => p > 0);
      rateValues = filterOutliers(rateValues);
      const medianRate = calculateMedian(rateValues);
      const mostRecentTimestamp = prices.reduce(
        (latest, p) => (p.timestamp > latest ? p.timestamp : latest),
        prices[0]?.timestamp ?? new Date(),
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
