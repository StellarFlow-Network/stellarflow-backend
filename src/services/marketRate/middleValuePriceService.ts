import axios from "axios";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../../utils/httpTimeout.js";
import { MarketRate } from "./types.js";
import { withRetry } from "../../utils/retryUtil.js";
import { createFetcherLogger } from "../../utils/logger.js";

/**
 * PriceSourceResult
 * Represents the result from a single price source API call
 */
interface PriceSourceResult {
  rate: number;
  timestamp: Date;
  source: string;
  success: boolean;
  error?: string;
}

/**
 * MiddleValuePriceService
 * 
 * This service waits for 3 different API responses before calculating the price.
 * It uses the middle value (median) of the three sources to reduce the impact 
 * of a single "rogue" API source.
 * 
 * This approach provides better price accuracy by:
 * 1. Waiting for multiple sources to respond
 * 2. Using the median value to eliminate outliers
 * 3. Reducing the impact of any single bad API source
 */
export class MiddleValuePriceService {
  private logger = createFetcherLogger("MiddleValuePriceService");

  /**
   * Fetch prices from multiple sources in parallel and return the middle value
   * 
   * @param sources - Array of functions that fetch prices from different APIs
   * @param currency - The currency code (e.g., 'NGN', 'KES', 'GHS')
   * @param timeoutMs - Maximum time to wait for all sources (default: 10000ms)
   * @returns MarketRate with the middle value price
   */
  async fetchMiddleValuePrice(
    sources: Array<() => Promise<{ rate: number; timestamp?: Date }>>,
    currency: string,
    timeoutMs: number = 10000,
  ): Promise<MarketRate> {
    if (sources.length < 3) {
      throw new Error("At least 3 price sources are required for middle value calculation");
    }

    const startTime = Date.now();
    this.logger.info(`Fetching prices from ${sources.length} sources for ${currency}`);

    // Fetch from all sources in parallel with timeout
    const fetchPromises = sources.map(async (sourceFn, index) => {
      try {
        const result = await Promise.race([
          sourceFn(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Source ${index + 1} timed out`)), timeoutMs)
          ),
        ]);

        return {
          rate: result.rate,
          timestamp: result.timestamp || new Date(),
          source: `Source ${index + 1}`,
          success: true,
        };
      } catch (error) {
        this.logger.warn(`Source ${index + 1} failed`, { 
          error: error instanceof Error ? error.message : String(error) 
        });
        return {
          rate: 0,
          timestamp: new Date(),
          source: `Source ${index + 1}`,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    // Wait for all sources to complete
    const results = await Promise.all(fetchPromises);
    const successfulResults = results.filter(r => r.success);

    this.logger.info(`Received ${successfulResults.length}/${sources.length} successful responses for ${currency}`, {
      duration: Date.now() - startTime,
    });

    // We need at least 3 successful responses for middle value calculation
    if (successfulResults.length < 3) {
      throw new Error(
        `Need at least 3 successful price sources, but only got ${successfulResults.length}. ` +
        `Failed sources: ${results.filter(r => !r.success).map(r => r.source).join(', ')}`
      );
    }

    // Extract rates and find the middle value (median)
    const rates = successfulResults.map(r => r.rate);
    const middleValue = this.calculateMiddleValue(rates);

    // Use the most recent timestamp from successful responses
    const mostRecentTimestamp = successfulResults.reduce(
      (latest, result) => (result.timestamp > latest ? result.timestamp : latest),
      successfulResults[0].timestamp,
    );

    this.logger.info(`Calculated middle value price for ${currency}`, {
      middleValue,
      sourceRates: rates,
      mostRecentTimestamp,
    });

    return {
      currency,
      rate: middleValue,
      timestamp: mostRecentTimestamp,
      source: `Middle value of ${successfulResults.length} sources`,
    };
  }

  /**
   * Calculate the middle value (median) from an array of prices
   * For 3 values, this is the second value when sorted
   * 
   * @param prices - Array of price values
   * @returns The middle value (median)
   */
  private calculateMiddleValue(prices: number[]): number {
    if (prices.length < 3) {
      throw new Error("At least 3 prices are required to calculate middle value");
    }

    // Sort prices in ascending order
    const sorted = [...prices].sort((a, b) => a - b);

    // For odd number of elements, return the middle one
    // For even number, return the average of the two middle ones
    const middle = Math.floor(sorted.length / 2);
    
    if (sorted.length % 2 === 1) {
      // Odd number: return the middle element
      return sorted[middle];
    } else {
      // Even number: return average of two middle elements
      const mid1 = sorted[middle - 1];
      const mid2 = sorted[middle];
      if (mid1 !== undefined && mid2 !== undefined) {
        return (mid1 + mid2) / 2;
      }
      return mid2 ?? mid1 ?? 0;
    }
  }

  /**
   * Create a price source function for CoinGecko API
   * 
   * @param coinGeckoUrl - The CoinGecko API URL
   * @param currencyCode - The currency code (e.g., 'ngn', 'kes', 'ghs')
   * @returns Function that fetches price from CoinGecko
   */
  createCoinGeckoSource(
    coinGeckoUrl: string,
    currencyCode: string,
  ): () => Promise<{ rate: number; timestamp?: Date }> {
    return async () => {
      const response = await withRetry(
        () =>
          axios.get<any>(coinGeckoUrl, {
            timeout: OUTGOING_HTTP_TIMEOUT_MS,
            headers: {
              "User-Agent": "StellarFlow-Oracle/1.0",
            },
          }),
        { maxRetries: 2, retryDelay: 1000 },
      );

      // Extract price from response (adjust based on actual response structure)
      const stellarData = response.data.stellar;
      if (!stellarData || typeof stellarData[currencyCode] !== "number" || stellarData[currencyCode] <= 0) {
        throw new Error(`Invalid CoinGecko response for ${currencyCode}`);
      }

      const timestamp = stellarData.last_updated_at
        ? new Date(stellarData.last_updated_at * 1000)
        : new Date();

      return {
        rate: stellarData[currencyCode],
        timestamp,
      };
    };
  }

  /**
   * Create a price source function for ExchangeRate API
   * 
   * @param exchangeRateUrl - The ExchangeRate API URL
   * @param currencyCode - The currency code (e.g., 'NGN', 'KES', 'GHS')
   * @returns Function that fetches price from ExchangeRate API
   */
  createExchangeRateSource(
    exchangeRateUrl: string,
    currencyCode: string,
  ): () => Promise<{ rate: number; timestamp?: Date }> {
    return async () => {
      const response = await withRetry(
        () =>
          axios.get<any>(exchangeRateUrl, {
            timeout: OUTGOING_HTTP_TIMEOUT_MS,
            headers: {
              "User-Agent": "StellarFlow-Oracle/1.0",
            },
          }),
        { maxRetries: 2, retryDelay: 1000 },
      );

      const data = response.data;
      if (data.result !== "success" || !data.rates || typeof data.rates[currencyCode] !== "number") {
        throw new Error(`Invalid ExchangeRate API response for ${currencyCode}`);
      }

      const timestamp = data.time_last_update_unix
        ? new Date(data.time_last_update_unix * 1000)
        : new Date();

      return {
        rate: data.rates[currencyCode],
        timestamp,
      };
    };
  }

  /**
   * Create a price source function for a custom API
   * 
   * @param url - The API URL
   * @param extractRate - Function to extract rate from response
   * @param extractTimestamp - Optional function to extract timestamp from response
   * @returns Function that fetches price from custom API
   */
  createCustomSource(
    url: string,
    extractRate: (data: any) => number,
    extractTimestamp?: (data: any) => Date,
  ): () => Promise<{ rate: number; timestamp?: Date }> {
    return async () => {
      const response = await withRetry(
        () =>
          axios.get<any>(url, {
            timeout: OUTGOING_HTTP_TIMEOUT_MS,
            headers: {
              "User-Agent": "StellarFlow-Oracle/1.0",
            },
          }),
        { maxRetries: 2, retryDelay: 1000 },
      );

      const rate = extractRate(response.data);
      if (!rate || rate <= 0) {
        throw new Error(`Invalid custom API response: rate is ${rate}`);
      }

      const timestamp = extractTimestamp
        ? extractTimestamp(response.data)
        : new Date();

      return { rate, timestamp };
    };
  }
}
