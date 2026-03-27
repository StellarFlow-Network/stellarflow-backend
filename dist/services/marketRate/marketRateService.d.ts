import { FetcherResponse, AggregatedFetcherResponse } from "./types";
export declare class MarketRateService {
    private fetchers;
    private cache;
    private stellarService;
    private readonly CACHE_DURATION_MS;
    private multiSigEnabled;
    private remoteOracleServers;
    constructor();
    private initializeFetchers;
    getRate(currency: string): Promise<FetcherResponse>;
    getAllRates(): Promise<FetcherResponse[]>;
    healthCheck(): Promise<Record<string, boolean>>;
    getSupportedCurrencies(): string[];
    getLatestPrices(): Promise<AggregatedFetcherResponse>;
    clearCache(): void;
    getPendingReviews(): Promise<import("../priceReviewService").PendingPriceReview[]>;
    approvePendingReview(reviewId: number, reviewedBy?: string, reviewNotes?: string): Promise<import("../priceReviewService").PendingPriceReview>;
    rejectPendingReview(reviewId: number, reviewedBy?: string, reviewNotes?: string): Promise<import("../priceReviewService").PendingPriceReview>;
    getCacheStatus(): Record<string, {
        cached: boolean;
        expiry?: Date;
    }>;
    /**
     * Asynchronously request signatures from remote oracle servers.
     * This is non-blocking and doesn't wait for completion.
     * Errors are logged but don't fail the price fetch operation.
     */
    private requestRemoteSignaturesAsync;
}
//# sourceMappingURL=marketRateService.d.ts.map