import { MarketRateFetcher, MarketRate } from './types';
export declare class GHSRateFetcher implements MarketRateFetcher {
    private readonly sources;
    getCurrency(): string;
    fetchRate(): Promise<MarketRate>;
    private fetchFromBOG;
    private fetchFromSource;
    isHealthy(): Promise<boolean>;
}
//# sourceMappingURL=ghsFetcher.d.ts.map