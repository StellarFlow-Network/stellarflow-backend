import { MarketRateService } from "./marketRate/marketRateService";
import { FetcherResponse, MarketRate } from "./marketRate/types";
import { normalizeDateToUTC } from "../utils/timeUtils";

export interface DerivedRate extends MarketRate {
  baseCurrency: string;
  quoteCurrency: string;
  calculationMethod: string;
}

export class DerivedAssetService {
  private marketRateService: MarketRateService;

  constructor(marketRateService: MarketRateService) {
    this.marketRateService = marketRateService;
  }

  /**
   * Calculate a synthetic cross-rate between two currencies.
   * Both currencies are assumed to be quoted against XLM in the MarketRateService.
   *
   * Example: NGN/GHS = (NGN/XLM) / (GHS/XLM)
   *
   * @param baseCurrency The currency to be valued (e.g., NGN)
   * @param quoteCurrency The currency used as a reference (e.g., GHS)
   * @returns A FetcherResponse containing the derived rate
   */
  async getDerivedRate(
    baseCurrency: string,
    quoteCurrency: string,
  ): Promise<FetcherResponse> {
    try {
      const base = baseCurrency.toUpperCase();
      const quote = quoteCurrency.toUpperCase();

      // Fetch base rate (e.g., NGN/XLM)
      const baseResponse = await this.marketRateService.getRate(base);
      if (!baseResponse.success || !baseResponse.data) {
        return {
          success: false,
          error: `Failed to fetch base rate for ${base}: ${baseResponse.error}`,
        };
      }

      // Fetch quote rate (e.g., GHS/XLM)
      const quoteResponse = await this.marketRateService.getRate(quote);
      if (!quoteResponse.success || !quoteResponse.data) {
        return {
          success: false,
          error: `Failed to fetch quote rate for ${quote}: ${quoteResponse.error}`,
        };
      }

      const baseRateValue = baseResponse.data.rate;
      const quoteRateValue = quoteResponse.data.rate;

      if (quoteRateValue === 0) {
        return {
          success: false,
          error: `Invalid rate for ${quote} (rate is 0)`,
        };
      }

      // Synthetic rate: how many units of base currency per 1 unit of quote currency
      // Since both are X/XLM:
      // (Base/XLM) / (Quote/XLM) = Base/Quote
      const derivedRateValue = baseRateValue / quoteRateValue;

      // Use the older timestamp of the two to be conservative
      const timestamp =
        baseResponse.data.timestamp < quoteResponse.data.timestamp
          ? baseResponse.data.timestamp
          : quoteResponse.data.timestamp;

      const derivedRate: DerivedRate = {
        currency: `${base}/${quote}`,
        baseCurrency: base,
        quoteCurrency: quote,
        rate: derivedRateValue,
        timestamp: normalizeDateToUTC(timestamp),
        source: "Synthetic (Derived from XLM rates)",
        calculationMethod: `(${base}/XLM) / (${quote}/XLM)`,
      };

      return {
        success: true,
        data: derivedRate,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error in DerivedAssetService",
      };
    }
  }

  /**
   * Specifically calculate NGN/GHS synthetic rate as requested.
   */
  async getNGNGHSRate(): Promise<FetcherResponse> {
    return this.getDerivedRate("NGN", "GHS");
  }
}

// Export a singleton-like instance if needed, but usually we instantiate with a MarketRateService
export const createDerivedAssetService = (
  marketRateService: MarketRateService,
) => {
  return new DerivedAssetService(marketRateService);
};
