import { MarketRateFetcher, MarketRate } from "./types";
/**
 * Circuit Breaker States
 */
declare enum CircuitState {
    CLOSED = "CLOSED",// Normal operation, requests pass through
    OPEN = "OPEN",// Failing, reject requests immediately
    HALF_OPEN = "HALF_OPEN"
}
/**
 * KES/XLM Rate Fetcher using Binance Public API
 * Implements multiple strategies to fetch KES rates:
 * 1. Direct Binance Spot API (XLMKES pair)
 * 2. Binance P2P API for KES
 * 3. Binance Spot API (XLMUSDT) × USD/KES calculation
 * 4. Fallback to Central Bank of Kenya
 */
export declare class KESRateFetcher implements MarketRateFetcher {
    private readonly circuitBreaker;
    private readonly retryConfig;
    constructor();
    /**
     * Get the currency code this fetcher handles
     */
    getCurrency(): string;
    /**
     * Fetch the KES/XLM rate with comprehensive error handling
     * Tries multiple strategies in order of reliability
     */
    fetchRate(): Promise<MarketRate>;
    /**
     * Fetch KES/XLM rate from Binance API
     * Tries multiple strategies:
     * 1. Direct XLMKES pair
     * 2. Binance P2P API
     * 3. XLMUSDT × KES/USD calculation
     * Returns all successful rates to calculate median
     */
    private fetchFromBinance;
    /**
     * Fetch a specific trading pair price from Binance Spot API
     */
    private fetchBinanceSpotPrice;
    /**
     * Fetch KES rates from Binance P2P API
     * Note: Binance P2P API may require authentication or have CORS restrictions
     */
    private fetchBinanceP2PRate;
    /**
     * Fetch KES/USD rate from Central Bank of Kenya
     */
    private fetchFromCBK;
    /**
     * Fetch rate from alternative sources
     */
    private fetchFromSource;
    /**
     * Handle API errors with detailed logging
     */
    private handleApiError;
    /**
     * Build comprehensive error message from all failures
     */
    private buildErrorMessage;
    /**
     * Health check for the fetcher
     * Tests Binance API availability specifically
     */
    isHealthy(): Promise<boolean>;
    /**
     * Get circuit breaker status for diagnostics
     */
    getCircuitBreakerStatus(): {
        state: CircuitState;
        failureCount: number;
    };
    /**
     * Reset circuit breaker (for manual intervention)
     */
    resetCircuitBreaker(): void;
}
export {};
//# sourceMappingURL=kesFetcher.d.ts.map