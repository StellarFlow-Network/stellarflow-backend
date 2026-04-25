import { MarketRate, FetcherResponse, AggregatedFetcherResponse } from "./types";
import type { RedisClientType } from "redis";
export declare class MarketRateService {
    private fetchers;
    private cache;
    private stellarService;
    private readonly LATEST_PRICES_REDIS_KEY;
    private readonly LATEST_PRICES_REDIS_TTL_SECONDS;
    private multiSigEnabled;
    private remoteOracleServers;
    private pendingSubmissions;
    private batchTimeout;
    private get CACHE_DURATION_MS();
    private get BATCH_WINDOW_MS();
    constructor();
    private initializeFetchers;
    getRate(currency: string): Promise<FetcherResponse>;
    getAllRates(): Promise<FetcherResponse[]>;
    private flushBatchSubmissions;
    healthCheck(): Promise<Record<string, boolean>>;
    getSupportedCurrencies(): string[];
    protected getLatestPricesCacheClient(): Pick<RedisClientType, "get" | "setEx" | "del"> | null;
    protected fetchLatestPricesFromDatabase(): Promise<MarketRate[]>;
    private parseLatestPricesCache;
    getLatestPrices(): Promise<AggregatedFetcherResponse>;
    clearCache(): void;
    getPendingReviews(): Promise<import("../priceReviewService").PendingPriceReview[]>;
    approvePendingReview(reviewId: number, reviewedBy?: string, reviewNotes?: string): Promise<import("../priceReviewService").PendingPriceReview>;
    rejectPendingReview(reviewId: number, reviewedBy?: string, reviewNotes?: string): Promise<import("../priceReviewService").PendingPriceReview>;
    getCacheStatus(): Record<string, {
        cached: boolean;
        expiry?: Date;
    }>;
    private requestRemoteSignaturesAsync;
}
//# sourceMappingURL=marketRateService.d.ts.map