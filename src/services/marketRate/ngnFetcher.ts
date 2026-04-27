import axios from "axios";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../../utils/httpTimeout.js";
import {
  MarketRateFetcher,
  MarketRate,
  calculateWeightedAverage,
  filterOutliers,
} from "./types";
import { withRetry } from "../../utils/retryUtil.js";
import {
  getNGNProviderWeight,
  type NGNProviderWeightKey,
} from "../../config/providerWeights.js";
import { createFetcherLogger } from "../../utils/logger.js";

type CoinGeckoPriceResponse = {
  stellar?: {
    ngn?: number;
    usd?: number;
    last_updated_at?: number;
  };
};

type ExchangeRateApiResponse = {
  result?: string;
  rates?: {
    NGN?: number;
  };
  time_last_update_unix?: number;
};

type VtpassVariation = {
  variation_code: string;
  name: string;
  variation_amount: string;
  variation_rate?: string;
  fixedPrice?: string;
};

type VtpassVariationsResponse = {
  response_description: string;
  content?: {
    variations?: VtpassVariation[];
  };
};

type NGNPriceCandidate = {
  rate: number;
  timestamp: Date;
  source: string;
  providerKey: NGNProviderWeightKey;
};

function parseAmount(value: string | undefined): number | null {
  if (value == null) return null;
  const n = Number.parseFloat(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * NGN/XLM rate fetcher.
 *
 * Primary path uses VTpass service variations to read a configured
 * variation's `variation_amount` as the Naira price for one unit of
 * the underlying SKU. That value is multiplied by CoinGecko XLM/USD
 * for NGN per XLM.
 *
 * Falls back to CoinGecko XLM/NGN directly, then XLM/USD x USD->NGN.
 */
export class NGNRateFetcher implements MarketRateFetcher {
  private readonly coinGeckoUrl =
    "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=ngn,usd&include_last_updated_at=true";

  private readonly usdToNgnUrl = "https://open.er-api.com/v6/latest/USD";
  private logger = createFetcherLogger("NGNRate");

  private vtpassBase(): string {
    return (
      process.env.VTPASS_API_BASE_URL ?? "https://vtpass.com/api"
    ).replace(/\/$/, "");
  }

  private vtpassHeaders(): Record<string, string> | undefined {
    const apiKey = process.env.VTPASS_API_KEY;
    const publicKey = process.env.VTPASS_PUBLIC_KEY;
    if (apiKey && publicKey) {
      return {
        "api-key": apiKey,
        "public-key": publicKey,
      };
    }
    return undefined;
  }

  getCurrency(): string {
    return "NGN";
  }

  private async fetchNgnPerUsdFromVtpass(): Promise<{
    ngnPerUsd: number;
    timestamp: Date;
  } | null> {
    const serviceId = process.env.VTPASS_NGN_SERVICE_ID?.trim();
    const variationCode = process.env.VTPASS_NGN_VARIATION_CODE?.trim();
    if (!serviceId || !variationCode) return null;

    const headers = this.vtpassHeaders();
    if (!headers) return null;

    const response = await withRetry(
      () =>
        axios.get<VtpassVariationsResponse>(
          `${this.vtpassBase()}/service-variations`,
          {
            params: { serviceID: serviceId },
            timeout: OUTGOING_HTTP_TIMEOUT_MS,
            headers: {
              ...headers,
              "User-Agent": "StellarFlow-Oracle/1.0",
            },
          },
        ),
      { maxRetries: 3, retryDelay: 1000 },
    );

    if (response.data.response_description !== "000") {
      return null;
    }

    const variations = response.data.content?.variations ?? [];
    const match = variations.find((v) => v.variation_code === variationCode);
    if (!match) return null;

    const rateFromField = parseAmount(match.variation_rate);
    const amount = parseAmount(match.variation_amount);
    const ngnPerUsd = rateFromField ?? amount;
    if (ngnPerUsd == null) return null;

    return { ngnPerUsd, timestamp: new Date() };
  }

  async fetchRate(): Promise<MarketRate> {
    const prices: NGNPriceCandidate[] = [];

    try {
      const vt = await this.fetchNgnPerUsdFromVtpass();
      if (vt) {
        const coinGeckoResponse = await withRetry(
          () =>
            axios.get<CoinGeckoPriceResponse>(this.coinGeckoUrl, {
              timeout: OUTGOING_HTTP_TIMEOUT_MS,
              headers: {
                "User-Agent": "StellarFlow-Oracle/1.0",
              },
            }),
          { maxRetries: 3, retryDelay: 1000 },
        );

        const usd = coinGeckoResponse.data.stellar?.usd;
        if (typeof usd === "number" && usd > 0) {
          const lastUpdatedAt = coinGeckoResponse.data.stellar?.last_updated_at
            ? new Date(coinGeckoResponse.data.stellar.last_updated_at * 1000)
            : new Date();
          const ts =
            vt.timestamp > lastUpdatedAt ? vt.timestamp : lastUpdatedAt;

          prices.push({
            rate: usd * vt.ngnPerUsd,
            timestamp: ts,
            source: "VTpass variation + CoinGecko (XLM/USD)",
            providerKey: "vtpassCoinGeckoUsd",
          });
        }
      }
    } catch (error) {
      this.logger.debug("VTpass + CoinGecko XLM/USD failed", { error: error instanceof Error ? error.message : error });
    }

    try {
      const coinGeckoResponse = await withRetry(
        () =>
          axios.get<CoinGeckoPriceResponse>(this.coinGeckoUrl, {
            timeout: OUTGOING_HTTP_TIMEOUT_MS,
            headers: {
              "User-Agent": "StellarFlow-Oracle/1.0",
            },
          }),
        { maxRetries: 3, retryDelay: 1000 },
      );

      const stellarPrice = coinGeckoResponse.data.stellar;
      if (
        stellarPrice &&
        typeof stellarPrice.ngn === "number" &&
        stellarPrice.ngn > 0
      ) {
        const lastUpdatedAt = stellarPrice.last_updated_at
          ? new Date(stellarPrice.last_updated_at * 1000)
          : new Date();

        prices.push({
          rate: stellarPrice.ngn,
          timestamp: lastUpdatedAt,
          source: "CoinGecko (direct NGN)",
          providerKey: "coinGeckoDirectNgn",
        });
      }
    } catch (error) {
      this.logger.debug("CoinGecko direct NGN failed", { error: error instanceof Error ? error.message : error });
    }

    try {
      const coinGeckoResponse = await withRetry(
        () =>
          axios.get<CoinGeckoPriceResponse>(this.coinGeckoUrl, {
            timeout: OUTGOING_HTTP_TIMEOUT_MS,
            headers: {
              "User-Agent": "StellarFlow-Oracle/1.0",
            },
          }),
        { maxRetries: 3, retryDelay: 1000 },
      );

      const stellarPrice = coinGeckoResponse.data.stellar;
      if (
        stellarPrice &&
        typeof stellarPrice.usd === "number" &&
        stellarPrice.usd > 0
      ) {
        const fxResponse = await withRetry(
          () =>
            axios.get<ExchangeRateApiResponse>(this.usdToNgnUrl, {
              timeout: OUTGOING_HTTP_TIMEOUT_MS,
              headers: {
                "User-Agent": "StellarFlow-Oracle/1.0",
              },
            }),
          { maxRetries: 3, retryDelay: 1000 },
        );

        const usdToNgn = fxResponse.data.rates?.NGN;
        if (
          fxResponse.data.result === "success" &&
          typeof usdToNgn === "number" &&
          usdToNgn > 0
        ) {
          const fxTimestamp = fxResponse.data.time_last_update_unix
            ? new Date(fxResponse.data.time_last_update_unix * 1000)
            : new Date();
          const lastUpdatedAt = stellarPrice.last_updated_at
            ? new Date(stellarPrice.last_updated_at * 1000)
            : new Date();

          prices.push({
            rate: stellarPrice.usd * usdToNgn,
            timestamp:
              fxTimestamp > lastUpdatedAt ? fxTimestamp : lastUpdatedAt,
            source: "CoinGecko + ExchangeRate API (USD->NGN)",
            providerKey: "coinGeckoExchangeRateUsdNgn",
          });
        }
      }
    } catch (error) {
      this.logger.debug("CoinGecko + ExchangeRate API (NGN) failed", { error: error instanceof Error ? error.message : error });
    }

    if (prices.length === 0) {
      const error = new Error("All NGN rate sources failed");
      this.logger.fetcherError(
        error,
        "All price sources failed - no rates obtained",
        { attemptedSources: 3, pricesLength: prices.length }
      );
      throw error;
    }

    const filteredRateValues = filterOutliers(
      prices.map((p) => p.rate).filter((rate) => rate > 0),
    );
    const filteredPrices = prices.filter((price) =>
      filteredRateValues.includes(price.rate),
    );
    const pricesToUse = filteredPrices.length > 0 ? filteredPrices : prices;

    const mostRecentTimestamp = prices.reduce(
      (latest, p) => (p.timestamp > latest ? p.timestamp : latest),
      prices[0]?.timestamp ?? new Date(),
    );

    const weightedRate = calculateWeightedAverage(
      pricesToUse.map((price) => ({
        value: price.rate,
        weight: getNGNProviderWeight(price.providerKey),
      })),
    );

    return {
      currency: "NGN",
      rate: weightedRate,
      timestamp: mostRecentTimestamp,
      source: `Weighted average of ${pricesToUse.length} sources (outliers filtered)`,
    };
  }

  async isHealthy(): Promise<boolean> {
    try {
      const rate = await this.fetchRate();
      this.logger.info("Health check passed", { rate: rate.rate, source: rate.source });
      return rate.rate > 0;
    } catch (error) {
      this.logger.error("Health check failed", undefined, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }
}
