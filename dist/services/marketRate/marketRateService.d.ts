import { FetcherResponse } from './types';
export declare class MarketRateService {
    private fetchers;
    private cache;
    private readonly CACHE_DURATION_MS;
    constructor();
    private initializeFetchers;
    getRate(currency: string): Promise<FetcherResponse>;
    getAllRates(): Promise<FetcherResponse[]>;
    healthCheck(): Promise<Record<string, boolean>>;
    getSupportedCurrencies(): string[];
    clearCache(): void;
    getCacheStatus(): Record<string, {
        cached: boolean;
        expiry?: Date;
    }>;
}
//# sourceMappingURL=marketRateService.d.ts.map