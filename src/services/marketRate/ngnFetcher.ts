import axios from "axios";
import { MarketRateFetcher, MarketRate, calculateMedian, filterOutliers, SourceTrustLevel, calculateWeightedAverage } from "./types";
import logger from "../../utils/logger";

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

function parseAmount(value: string | undefined): number | null {
  if (value == null) return null;
  const n = Number.parseFloat(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * NGN/XLM rate fetcher.
 *
 * Primary path uses VTpass {@link https://www.vtpass.com/documentation/variation-codes/ service-variations}
 * to read a configured variation's `variation_amount` as the Naira price for one unit of the underlying
 * SKU (configure a 1 USD/BUSD reference variation so `variation_amount` ≈ NGN per USD). That value is
 * multiplied by CoinGecko XLM/USD for NGN per XLM.
 *
 * Falls back to CoinGecko XLM/NGN directly, then XLM/USD × USD→NGN (open.er-api), matching other fetchers.
 */
export class NGNRateFetcher implements MarketRateFetcher {
  private readonly coinGeckoUrl =
    "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=ngn,usd&include_last_updated_at=true";

  private readonly usdToNgnUrl = "https://open.er-api.com/v6/latest/USD";

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

    const response = await axios.get<VtpassVariationsResponse>(
      `${this.vtpassBase()}/service-variations`,
      {
        params: { serviceID: serviceId },
        timeout: 15000,
        headers: {
          ...headers,
          "User-Agent": "StellarFlow-Oracle/1.0",
        },
      },
    );

    if (response.data.response_description !== "000") {
      return null;
    }

    const variations = response.data.content?.variations ?? [];
    const match = variations.find(
      (v) => v.variation_code === variationCode,
    );
    if (!match) return null;

    const rateFromField = parseAmount(match.variation_rate);
    const amount = parseAmount(match.variation_amount);
    const ngnPerUsd = rateFromField ?? amount;
    if (ngnPerUsd == null) return null;

    return { ngnPerUsd, timestamp: new Date() };
  }

  async fetchRate(): Promise<MarketRate> {
    const prices: {
      rate: number;
      timestamp: Date;
      source: string;
      trustLevel: SourceTrustLevel;
    }[] = [];

    // Strategy 1: VTpass NGN-per-USD (variation) × CoinGecko XLM/USD
    try {
      const vt = await this.fetchNgnPerUsdFromVtpass();
      if (vt) {
        const coinGeckoResponse = await axios.get<CoinGeckoPriceResponse>(
          this.coinGeckoUrl,
          {
            timeout: 10000,
            headers: {
              "User-Agent": "StellarFlow-Oracle/1.0",
            },
          },
        );

        const usd = coinGeckoResponse.data.stellar?.usd;
        if (typeof usd === "number" && usd > 0) {
          const lastUpdatedAt = coinGeckoResponse.data.stellar?.last_updated_at
            ? new Date(
                coinGeckoResponse.data.stellar.last_updated_at * 1000,
              )
            : new Date();
          const ts =
            vt.timestamp > lastUpdatedAt ? vt.timestamp : lastUpdatedAt;
          prices.push({
            rate: usd * vt.ngnPerUsd,
            timestamp: ts,
            source: "VTpass variation + CoinGecko (XLM/USD)",
            trustLevel: "new",
          });
        }
      }
    } catch {
      logger.debug("VTpass + CoinGecko XLM/USD failed");
    }

    // Strategy 2: CoinGecko direct XLM/NGN
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
          trustLevel: "standard",
        });
      }
    } catch {
      logger.debug("CoinGecko direct NGN failed");
    }

    // Strategy 3: CoinGecko XLM/USD × USD/NGN (open.er-api)
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
        const fxResponse = await axios.get<ExchangeRateApiResponse>(
          this.usdToNgnUrl,
          {
            timeout: 10000,
            headers: {
              "User-Agent": "StellarFlow-Oracle/1.0",
            },
          },
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
            source: "CoinGecko + ExchangeRate API (USD→NGN)",
            trustLevel: "trusted",
          });
        }
      }
    } catch {
      logger.debug("CoinGecko + ExchangeRate API (NGN) failed");
    }

    if (prices.length > 0) {
      let rateValues = prices.map((p) => p.rate).filter(p => p > 0);
      rateValues = filterOutliers(rateValues);
      const mostRecentTimestamp = prices.reduce(
        (latest, p) => (p.timestamp > latest ? p.timestamp : latest),
        prices[0]?.timestamp ?? new Date(),
      );

      const weightedInput = prices.map((p) => ({
        value: p.rate,
        trustLevel: p.trustLevel as SourceTrustLevel,
      }));
      const weightedRate = calculateWeightedAverage(weightedInput);

      return {
        currency: "NGN",
        rate: weightedRate,
        timestamp: mostRecentTimestamp,
        source: `Weighted average of ${prices.length} sources (outliers filtered)`,
      };
    }

    throw new Error("All NGN rate sources failed");
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
