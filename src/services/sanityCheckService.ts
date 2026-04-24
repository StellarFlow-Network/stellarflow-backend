import axios from "axios";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../../utils/httpTimeout";
import { withRetry } from "../../utils/retryUtil";
import { createFetcherLogger } from "../../utils/logger";
import { webhookReporter } from "../../utils/webhookReporter";

interface SanityCheckResult {
  currency: string;
  oraclePrice: number;
  externalPrice: number;
  deviation: number;
  deviationPercent: number;
  passed: boolean;
  source: string;
  timestamp: Date;
}

interface ExternalPriceSource {
  name: string;
  fetchPrice: (currency: string) => Promise<number | null>;
}

/**
 * Sanity Check Service
 * Compares Oracle prices with external sources (Google Finance, CoinGecko, etc.)
 * and alerts admins if deviation exceeds threshold
 */
export class SanityCheckService {
  private readonly DEVIATION_THRESHOLD = 2.0; // 2% threshold
  private readonly logger = createFetcherLogger("SanityCheck");
  private externalSources: ExternalPriceSource[];

  constructor() {
    this.externalSources = [
      {
        name: "CoinGecko",
        fetchPrice: this.fetchFromCoinGecko.bind(this),
      },
      {
        name: "ExchangeRate-API",
        fetchPrice: this.fetchFromExchangeRateAPI.bind(this),
      },
    ];
  }

  /**
   * Fetch price from CoinGecko
   */
  private async fetchFromCoinGecko(currency: string): Promise<number | null> {
    try {
      const currencyMap: Record<string, string> = {
        NGN: "ngn",
        KES: "kes",
        GHS: "ghs",
      };

      const vsCurrency = currencyMap[currency.toUpperCase()];
      if (!vsCurrency) return null;

      const response = await withRetry(
        () =>
          axios.get(
            `https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=${vsCurrency}`,
            {
              timeout: OUTGOING_HTTP_TIMEOUT_MS,
              headers: {
                "User-Agent": "StellarFlow-Oracle/1.0",
              },
            },
          ),
        { maxRetries: 2, retryDelay: 1000 },
      );

      const price = response.data?.stellar?.[vsCurrency];
      return typeof price === "number" && price > 0 ? price : null;
    } catch (error) {
      this.logger.debug(`CoinGecko fetch failed for ${currency}`, {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Fetch price from ExchangeRate-API (for USD conversion)
   */
  private async fetchFromExchangeRateAPI(
    currency: string,
  ): Promise<number | null> {
    try {
      // Get XLM/USD from CoinGecko
      const xlmUsdResponse = await withRetry(
        () =>
          axios.get(
            "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd",
            {
              timeout: OUTGOING_HTTP_TIMEOUT_MS,
              headers: {
                "User-Agent": "StellarFlow-Oracle/1.0",
              },
            },
          ),
        { maxRetries: 2, retryDelay: 1000 },
      );

      const xlmUsd = xlmUsdResponse.data?.stellar?.usd;
      if (typeof xlmUsd !== "number" || xlmUsd <= 0) return null;

      // Get USD to local currency rate
      const fxResponse = await withRetry(
        () =>
          axios.get("https://open.er-api.com/v6/latest/USD", {
            timeout: OUTGOING_HTTP_TIMEOUT_MS,
            headers: {
              "User-Agent": "StellarFlow-Oracle/1.0",
            },
          }),
        { maxRetries: 2, retryDelay: 1000 },
      );

      const rate = fxResponse.data?.rates?.[currency.toUpperCase()];
      if (
        fxResponse.data?.result === "success" &&
        typeof rate === "number" &&
        rate > 0
      ) {
        return xlmUsd * rate;
      }

      return null;
    } catch (error) {
      this.logger.debug(`ExchangeRate-API fetch failed for ${currency}`, {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Calculate percentage deviation between two prices
   */
  private calculateDeviation(price1: number, price2: number): number {
    return Math.abs(((price1 - price2) / price2) * 100);
  }

  /**
   * Perform sanity check for a specific currency
   */
  async checkPrice(
    currency: string,
    oraclePrice: number,
  ): Promise<SanityCheckResult | null> {
    const normalizedCurrency = currency.toUpperCase();

    // Try each external source until we get a valid price
    for (const source of this.externalSources) {
      try {
        const externalPrice = await source.fetchPrice(normalizedCurrency);

        if (externalPrice === null || externalPrice <= 0) {
          continue;
        }

        const deviation = this.calculateDeviation(oraclePrice, externalPrice);
        const deviationPercent = Number(deviation.toFixed(2));
        const passed = deviationPercent <= this.DEVIATION_THRESHOLD;

        const result: SanityCheckResult = {
          currency: normalizedCurrency,
          oraclePrice,
          externalPrice,
          deviation: Math.abs(oraclePrice - externalPrice),
          deviationPercent,
          passed,
          source: source.name,
          timestamp: new Date(),
        };

        // Log warning if threshold exceeded
        if (!passed) {
          this.logger.warn(
            `⚠️ SANITY CHECK FAILED: ${normalizedCurrency} price deviation exceeds ${this.DEVIATION_THRESHOLD}%`,
            {
              currency: normalizedCurrency,
              oraclePrice,
              externalPrice,
              deviationPercent,
              threshold: this.DEVIATION_THRESHOLD,
              source: source.name,
            },
          );

          // Send webhook alert to admins
          await this.sendAlert(result);
        } else {
          this.logger.debug(
            `✅ Sanity check passed for ${normalizedCurrency}`,
            {
              oraclePrice,
              externalPrice,
              deviationPercent,
              source: source.name,
            },
          );
        }

        return result;
      } catch (error) {
        this.logger.debug(`Sanity check source ${source.name} failed`, {
          error: error instanceof Error ? error.message : error,
        });
        continue;
      }
    }

    // All sources failed
    this.logger.warn(
      `Unable to perform sanity check for ${normalizedCurrency} - all external sources failed`,
    );
    return null;
  }

  /**
   * Send alert to admins via webhook
   */
  private async sendAlert(result: SanityCheckResult): Promise<void> {
    try {
      const message = `🚨 **Price Sanity Check Alert**

**Currency:** ${result.currency}
**Oracle Price:** ${result.oraclePrice.toFixed(4)}
**External Price (${result.source}):** ${result.externalPrice.toFixed(4)}
**Deviation:** ${result.deviationPercent}% (Threshold: ${this.DEVIATION_THRESHOLD}%)
**Difference:** ${result.deviation.toFixed(4)}

The Oracle price differs significantly from the external source. Please review.`;

      await webhookReporter.sendAlert({
        title: `Price Sanity Check Failed - ${result.currency}`,
        message,
        severity: "warning",
        metadata: {
          currency: result.currency,
          oraclePrice: result.oraclePrice,
          externalPrice: result.externalPrice,
          deviationPercent: result.deviationPercent,
          source: result.source,
          timestamp: result.timestamp.toISOString(),
        },
      });
    } catch (error) {
      this.logger.error(
        "Failed to send sanity check alert",
        undefined,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Perform sanity checks for multiple currencies
   */
  async checkPrices(
    prices: Array<{ currency: string; price: number }>,
  ): Promise<SanityCheckResult[]> {
    const results: SanityCheckResult[] = [];

    for (const { currency, price } of prices) {
      const result = await this.checkPrice(currency, price);
      if (result) {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Get sanity check threshold
   */
  getThreshold(): number {
    return this.DEVIATION_THRESHOLD;
  }
}

export const sanityCheckService = new SanityCheckService();
