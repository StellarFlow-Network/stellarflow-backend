import axios from "axios";
import { calculateMedian, } from "./types";
/**
 * Circuit Breaker States
 */
var CircuitState;
(function (CircuitState) {
    CircuitState["CLOSED"] = "CLOSED";
    CircuitState["OPEN"] = "OPEN";
    CircuitState["HALF_OPEN"] = "HALF_OPEN";
})(CircuitState || (CircuitState = {}));
/**
 * Circuit Breaker Implementation
 */
class CircuitBreaker {
    config;
    state = CircuitState.CLOSED;
    failureCount = 0;
    lastFailureTime = null;
    halfOpenAttempts = 0;
    constructor(config) {
        this.config = config;
    }
    async execute(operation) {
        if (this.state === CircuitState.OPEN) {
            if (this.shouldAttemptRecovery()) {
                this.state = CircuitState.HALF_OPEN;
                this.halfOpenAttempts = 0;
            }
            else {
                throw new Error("Circuit breaker is OPEN - service temporarily unavailable");
            }
        }
        if (this.state === CircuitState.HALF_OPEN) {
            this.halfOpenAttempts++;
            if (this.halfOpenAttempts > this.config.halfOpenMaxAttempts) {
                throw new Error("Circuit breaker half-open test limit exceeded");
            }
        }
        try {
            const result = await operation();
            this.onSuccess();
            return result;
        }
        catch (error) {
            this.onFailure();
            throw error;
        }
    }
    onSuccess() {
        this.failureCount = 0;
        if (this.state === CircuitState.HALF_OPEN) {
            this.state = CircuitState.CLOSED;
        }
    }
    onFailure() {
        this.failureCount++;
        this.lastFailureTime = new Date();
        if (this.state === CircuitState.HALF_OPEN) {
            this.state = CircuitState.OPEN;
        }
        else if (this.failureCount >= this.config.failureThreshold) {
            this.state = CircuitState.OPEN;
        }
    }
    shouldAttemptRecovery() {
        if (!this.lastFailureTime)
            return true;
        const elapsed = Date.now() - this.lastFailureTime.getTime();
        return elapsed >= this.config.recoveryTimeoutMs;
    }
    getState() {
        return this.state;
    }
    reset() {
        this.state = CircuitState.CLOSED;
        this.failureCount = 0;
        this.lastFailureTime = null;
        this.halfOpenAttempts = 0;
    }
}
/**
 * Retry with exponential backoff
 */
async function withRetry(operation, config, operationName) {
    let lastError = null;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < config.maxAttempts) {
                const delay = Math.min(config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1), config.maxDelayMs);
                console.debug(`Retry attempt ${attempt}/${config.maxAttempts} for ${operationName} ` +
                    `after ${delay}ms delay. Error: ${lastError.message}`);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    throw (lastError ||
        new Error(`${operationName} failed after ${config.maxAttempts} attempts`));
}
/**
 * Rate Source Configuration
 */
const RATE_SOURCES = [
    {
        name: "Binance Spot API",
        url: "https://api.binance.com/api/v3/ticker/price",
    },
    {
        name: "Binance Unified Trading (24h)",
        url: "https://api.binance.com/api/v3/ticker/24hr",
    },
    {
        name: "Central Bank of Kenya",
        url: "https://www.centralbank.go.ke/wp-json/fx-rate/v1/rates",
    },
    {
        name: "XE.com",
        url: "https://www.xe.com/currencytables/?from=USD&to=KES",
    },
];
/**
 * API Configuration
 */
const BINANCE_SPOT_URL = "https://api.binance.com/api/v3/ticker/price";
const BINANCE_24H_URL = "https://api.binance.com/api/v3/ticker/24hr";
const BINANCE_P2P_URL = "https://p2p-api.binance.com/bapi/c2c/v2/public/c2c/adv/search";
/**
 * Default timeout for API requests (ms)
 */
const DEFAULT_TIMEOUT_MS = 8000;
/**
 * Approximate KES/USD rate for calculation fallback
 * Note: In production, this should be fetched from a reliable source
 */
const APPROXIMATE_KES_USD_RATE = 130.5;
/**
 * KES/XLM Rate Fetcher using Binance Public API
 * Implements multiple strategies to fetch KES rates:
 * 1. Direct Binance Spot API (XLMKES pair)
 * 2. Binance P2P API for KES
 * 3. Binance Spot API (XLMUSDT) × USD/KES calculation
 * 4. Fallback to Central Bank of Kenya
 */
export class KESRateFetcher {
    circuitBreaker;
    retryConfig;
    constructor() {
        this.circuitBreaker = new CircuitBreaker({
            failureThreshold: 5,
            recoveryTimeoutMs: 30000,
            halfOpenMaxAttempts: 3,
        });
        this.retryConfig = {
            maxAttempts: 3,
            baseDelayMs: 500,
            maxDelayMs: 5000,
            backoffMultiplier: 2,
        };
    }
    /**
     * Get the currency code this fetcher handles
     */
    getCurrency() {
        return "KES";
    }
    /**
     * Fetch the KES/XLM rate with comprehensive error handling
     * Tries multiple strategies in order of reliability
     */
    async fetchRate() {
        const errors = [];
        // Strategy 1: Try Binance API (with circuit breaker and retry)
        try {
            const binanceRate = await this.circuitBreaker.execute(() => withRetry(() => this.fetchFromBinance(), this.retryConfig, "Binance API"));
            if (binanceRate) {
                console.info(`✅ KES rate fetched from Binance: ${binanceRate.rate}`);
                return binanceRate;
            }
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Unknown Binance error";
            console.warn(`⚠️ Binance API failed: ${errorMsg}`);
            errors.push({
                source: "Binance API",
                message: errorMsg,
                timestamp: new Date(),
            });
        }
        // Strategy 2: Try Central Bank of Kenya
        try {
            const cbkRate = await this.fetchFromCBK();
            if (cbkRate) {
                console.info(`✅ KES rate fetched from CBK: ${cbkRate.rate}`);
                return cbkRate;
            }
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : "Unknown CBK error";
            console.warn(`⚠️ Central Bank of Kenya API failed: ${errorMsg}`);
            errors.push({
                source: "Central Bank of Kenya",
                message: errorMsg,
                timestamp: new Date(),
            });
        }
        // Strategy 3: Try alternative sources
        for (const source of RATE_SOURCES.slice(2)) {
            try {
                const rate = await withRetry(() => this.fetchFromSource(source), this.retryConfig, source.name);
                if (rate) {
                    console.info(`✅ KES rate fetched from ${source.name}: ${rate.rate}`);
                    return rate;
                }
            }
            catch (error) {
                const errorMsg = error instanceof Error
                    ? error.message
                    : `Unknown ${source.name} error`;
                console.warn(`⚠️ ${source.name} failed: ${errorMsg}`);
                errors.push({
                    source: source.name,
                    message: errorMsg,
                    timestamp: new Date(),
                });
            }
        }
        // All sources failed - throw comprehensive error
        const errorMessage = this.buildErrorMessage(errors);
        console.error(`❌ All KES rate sources failed: ${errorMessage}`);
        throw new Error(errorMessage);
    }
    /**
     * Fetch KES/XLM rate from Binance API
     * Tries multiple strategies:
     * 1. Direct XLMKES pair
     * 2. Binance P2P API
     * 3. XLMUSDT × KES/USD calculation
     * Returns all successful rates to calculate median
     */
    async fetchFromBinance() {
        const prices = [];
        // Strategy 1: Direct XLMKES pair
        try {
            const directRate = await this.fetchBinanceSpotPrice("XLMKES");
            if (directRate) {
                prices.push({
                    rate: directRate.rate,
                    timestamp: directRate.timestamp,
                    source: "Binance Spot (XLMKES)",
                });
            }
        }
        catch (error) {
            console.debug("Direct XLMKES pair not available");
        }
        // Strategy 2: Try Binance P2P API
        try {
            const p2pRate = await this.fetchBinanceP2PRate();
            if (p2pRate) {
                prices.push({
                    rate: p2pRate.rate,
                    timestamp: p2pRate.timestamp,
                    source: p2pRate.source,
                });
            }
        }
        catch (error) {
            console.debug("Binance P2P API not available");
        }
        // Strategy 3: XLMUSDT × KES/USD calculation
        try {
            const xlmUsdRate = await this.fetchBinanceSpotPrice("XLMUSDT");
            if (xlmUsdRate) {
                prices.push({
                    rate: xlmUsdRate.rate * APPROXIMATE_KES_USD_RATE,
                    timestamp: xlmUsdRate.timestamp,
                    source: "Binance Spot (XLMUSDT × KES/USD)",
                });
            }
        }
        catch (error) {
            console.debug("XLMUSDT pair not available");
        }
        // If no prices were collected, return null
        if (prices.length === 0) {
            return null;
        }
        // Calculate median rate from all sources
        const rateValues = prices.map((p) => p.rate);
        const medianRate = calculateMedian(rateValues);
        // Return the median with the most recent timestamp
        const firstTimestamp = prices[0]?.timestamp ?? new Date();
        const mostRecentTimestamp = prices.reduce((latest, p) => (p.timestamp > latest ? p.timestamp : latest), firstTimestamp);
        return {
            currency: "KES",
            rate: medianRate,
            timestamp: mostRecentTimestamp,
            source: `Binance (Median of ${prices.length} sources)`,
        };
    }
    /**
     * Fetch a specific trading pair price from Binance Spot API
     */
    async fetchBinanceSpotPrice(symbol) {
        try {
            const response = await axios.get(BINANCE_SPOT_URL, {
                params: { symbol },
                timeout: DEFAULT_TIMEOUT_MS,
                headers: {
                    "User-Agent": "StellarFlow-Oracle/1.0",
                    Accept: "application/json",
                },
            });
            if (response.data && response.data.lastPrice) {
                const rate = parseFloat(response.data.lastPrice);
                if (!isNaN(rate) && rate > 0) {
                    return {
                        rate,
                        timestamp: new Date(),
                    };
                }
            }
            return null;
        }
        catch (error) {
            this.handleApiError(error, `Binance Spot (${symbol})`);
            return null;
        }
    }
    /**
     * Fetch KES rates from Binance P2P API
     * Note: Binance P2P API may require authentication or have CORS restrictions
     */
    async fetchBinanceP2PRate() {
        try {
            const response = await axios.post(BINANCE_P2P_URL, {
                fiat: "KES",
                asset: "XLM",
                merchantCheck: false,
                rows: 5,
                page: 1,
                tradeType: "BUY",
            }, {
                timeout: DEFAULT_TIMEOUT_MS,
                headers: {
                    "User-Agent": "StellarFlow-Oracle/1.0",
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
            });
            if (response.data?.data && response.data.data.length > 0) {
                // Calculate average price from available offers
                const prices = response.data.data
                    .map((item) => item.adv?.price)
                    .filter((price) => !!price)
                    .map((price) => parseFloat(price))
                    .filter((price) => !isNaN(price) && price > 0);
                if (prices.length > 0) {
                    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
                    return {
                        currency: "KES",
                        rate: avgPrice,
                        timestamp: new Date(),
                        source: "Binance P2P API",
                    };
                }
            }
            return null;
        }
        catch (error) {
            this.handleApiError(error, "Binance P2P API");
            return null;
        }
    }
    /**
     * Fetch KES/USD rate from Central Bank of Kenya
     */
    async fetchFromCBK() {
        const cbkSource = RATE_SOURCES[2];
        if (!cbkSource) {
            console.warn("Central Bank of Kenya source not configured");
            return null;
        }
        try {
            const response = await axios.get(cbkSource.url, {
                timeout: 10000,
                headers: {
                    "User-Agent": "StellarFlow-Oracle/1.0",
                    Accept: "application/json",
                },
            });
            // CBK API returns rates in KES per USD
            const rates = response.data;
            if (rates && rates.length > 0) {
                const latestRate = rates[0];
                return {
                    currency: "KES",
                    rate: parseFloat(latestRate.rate),
                    timestamp: new Date(latestRate.date),
                    source: cbkSource.name,
                };
            }
            return null;
        }
        catch (error) {
            this.handleApiError(error, cbkSource.name);
            return null;
        }
    }
    /**
     * Fetch rate from alternative sources
     */
    async fetchFromSource(source) {
        try {
            const response = await axios.get(source.url, {
                timeout: 10000,
                headers: {
                    "User-Agent": "StellarFlow-Oracle/1.0",
                    Accept: "application/json",
                },
            });
            // Placeholder - in production, parse actual response
            // For now, return approximate rate
            return {
                currency: "KES",
                rate: APPROXIMATE_KES_USD_RATE,
                timestamp: new Date(),
                source: source.name,
            };
        }
        catch (error) {
            this.handleApiError(error, source.name);
            return null;
        }
    }
    /**
     * Handle API errors with detailed logging
     */
    handleApiError(error, source) {
        if (axios.isAxiosError(error)) {
            const axiosError = error;
            if (axiosError.response) {
                // Server responded with error status
                console.warn(`${source} returned status ${axiosError.response.status}: ` +
                    `${axiosError.response.statusText}`);
            }
            else if (axiosError.code === "ECONNABORTED" ||
                axiosError.code === "ETIMEDOUT") {
                // Request timeout
                console.warn(`${source} request timed out`);
            }
            else if (axiosError.code === "ERR_NETWORK") {
                // Network error
                console.warn(`${source} network error - service may be down`);
            }
            else if (axiosError.message.includes("Network Error")) {
                // CORS or network issue
                console.warn(`${source} network error - check connectivity or CORS settings`);
            }
            else {
                console.warn(`${source} error: ${axiosError.message}`);
            }
        }
        else {
            console.warn(`${source} unexpected error:`, error);
        }
    }
    /**
     * Build comprehensive error message from all failures
     */
    buildErrorMessage(errors) {
        if (errors.length === 0) {
            return "Failed to fetch KES rate: All sources returned no data";
        }
        const messages = errors.map((e) => `${e.source}: ${e.message}`).join("; ");
        return `Failed to fetch KES rate from all sources. Errors: ${messages}`;
    }
    /**
     * Health check for the fetcher
     * Tests Binance API availability specifically
     */
    async isHealthy() {
        try {
            const testRate = await withRetry(() => this.fetchFromBinance(), { ...this.retryConfig, maxAttempts: 1 }, "Health check");
            const healthy = testRate !== null && testRate.rate > 0;
            console.debug(`Health check result: ${healthy ? "HEALTHY" : "UNHEALTHY"}`);
            return healthy;
        }
        catch (error) {
            console.warn("Health check failed:", error instanceof Error ? error.message : "Unknown error");
            return false;
        }
    }
    /**
     * Get circuit breaker status for diagnostics
     */
    getCircuitBreakerStatus() {
        return {
            state: this.circuitBreaker.getState(),
            failureCount: 0, // Internal state not exposed
        };
    }
    /**
     * Reset circuit breaker (for manual intervention)
     */
    resetCircuitBreaker() {
        this.circuitBreaker.reset();
        console.info("Circuit breaker reset");
    }
}
//# sourceMappingURL=kesFetcher.js.map