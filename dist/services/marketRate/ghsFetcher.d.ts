import { MarketRateFetcher, MarketRate } from "./types";
export declare class GHSRateFetcher implements MarketRateFetcher {
    private readonly coinGeckoUrl;
    private readonly usdToGhsUrl;
    getCurrency(): string;
    fetchRate(): Promise<MarketRate>;
    isHealthy(): Promise<boolean>;
}
//# sourceMappingURL=ghsFetcher.d.ts.map