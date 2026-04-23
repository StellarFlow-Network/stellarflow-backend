import { MarketRateFetcher, MarketRate } from "./types";
/**
 * GHS/XLM rate fetcher using CoinGecko as primary source.
 */
export declare class GHSRateFetcher implements MarketRateFetcher {
    private readonly coinGeckoUrl;
    private logger;
    getCurrency(): string;
    fetchRate(): Promise<MarketRate>;
    isHealthy(): Promise<boolean>;
}
//# sourceMappingURL=ghsFetcher.d.ts.map