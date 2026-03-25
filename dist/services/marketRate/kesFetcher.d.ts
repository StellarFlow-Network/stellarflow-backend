import { MarketRateFetcher, MarketRate } from './types';
export declare class KESRateFetcher implements MarketRateFetcher {
    private readonly sources;
    getCurrency(): string;
    fetchRate(): Promise<MarketRate>;
    private fetchFromCBK;
    private fetchFromSource;
    isHealthy(): Promise<boolean>;
}
//# sourceMappingURL=kesFetcher.d.ts.map