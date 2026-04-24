import { MarketRateFetcher, MarketRate } from "./types";
/**
 * KES/XLM rate fetcher using CoinGecko as primary source.
 */
export declare class KESRateFetcher implements MarketRateFetcher {
    private readonly coinGeckoUrl;
    private logger;
    getCurrency(): string;
    fetchRate(): Promise<MarketRate>;
    isHealthy(): Promise<boolean>;
}
//# sourceMappingURL=kesFetcher.d.ts.map