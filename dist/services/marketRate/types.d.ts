/**
 * Market Rate Interface
 * Represents the fetched exchange rate data
 */
export interface MarketRate {
    currency: string;
    rate: number;
    timestamp: Date;
    source: string;
    manualReviewRequired?: boolean | undefined;
    reviewId?: number | undefined;
    reviewReason?: string | undefined;
    reviewChangePercent?: number | undefined;
    comparisonRate?: number | undefined;
    comparisonTimestamp?: Date | undefined;
    contractSubmissionSkipped?: boolean;
    pendingMultiSig?: boolean;
    multiSigPriceId?: number;
}
/**
 * Market Rate Fetcher Interface
 * Contract for all currency rate fetcher implementations
 */
export interface MarketRateFetcher {
    /**
     * Get the currency code this fetcher handles
     */
    getCurrency(): string;
    /**
     * Fetch the current exchange rate
     * @throws Error if all rate sources fail
     */
    fetchRate(): Promise<MarketRate>;
    /**
     * Check if the fetcher is healthy and can reach its sources
     */
    isHealthy(): Promise<boolean>;
}
/**
 * Rate Source Configuration
 * Represents an external API source for exchange rates
 */
export interface RateSource {
    name: string;
    url: string;
    apiKey?: string;
}
/**
 * Fetcher Response Wrapper
 * Standardized response format for rate fetcher operations
 */
export interface FetcherResponse {
    success: boolean;
    data?: MarketRate;
    error?: string;
}
/**
 * Aggregated Response for multiple fetchers
 * Used when fetching rates from multiple currency sources
 */
export interface AggregatedFetcherResponse {
    success: boolean;
    data?: MarketRate[];
    error?: string;
    errors?: string[];
}
/**
 * Rate Fetch Error
 * Detailed error information for failed rate fetches
 */
export interface RateFetchError {
    source: string;
    message: string;
    timestamp: Date;
    retryable?: boolean;
}
/**
 * Circuit Breaker State
 * Represents the state of a circuit breaker
 */
export declare enum CircuitBreakerState {
    CLOSED = "CLOSED",
    OPEN = "OPEN",
    HALF_OPEN = "HALF_OPEN"
}
/**
 * Health Check Response
 * Standardized health check response
 */
export interface HealthCheckResponse {
    healthy: boolean;
    lastChecked: Date;
    latencyMs?: number;
    error?: string;
}
/**
 * Source trust tier used when weighting multi-source rates.
 */
export type SourceTrustLevel = "trusted" | "standard" | "new";
/**
 * Calculate the median of an array of numbers
 * This helps prevent a single bad API from ruining the data
 * @param values - Array of price numbers from different sources
 * @returns The median value
 */
export declare function calculateMedian(values: number[]): number;
/**
 * Calculate the simple average (arithmetic mean) of an array of numbers.
 * Used to produce one final price from multiple source prices (e.g. NGN).
 * @param prices - Array of price numbers from different sources
 * @returns The arithmetic mean, or 0 for an empty array
 */
export declare function calculateAverage(prices: number[]): number;
export interface WeightedPriceInput {
    value: number;
    trustLevel?: SourceTrustLevel;
    weight?: number;
}
/**
 * Calculate weighted average from source values.
 * Use explicit `weight` when provided, otherwise derive by trust level.
 */
export declare function calculateWeightedAverage(values: WeightedPriceInput[]): number;
/**
 * Rate Fetch Statistics
 * Performance and reliability metrics
 */
export { filterOutliers, isOutlier, percentDeviation, } from "../../logic/outlierFilter";
export interface RateFetchStats {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageLatencyMs: number;
    lastSuccessfulFetch?: Date;
    lastFailedFetch?: Date;
}
//# sourceMappingURL=types.d.ts.map