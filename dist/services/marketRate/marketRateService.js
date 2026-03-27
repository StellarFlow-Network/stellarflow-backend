import { KESRateFetcher } from "./kesFetcher";
import { GHSRateFetcher } from "./ghsFetcher";
import { NGNRateFetcher } from "./ngnFetcher";
import { StellarService } from "../stellarService";
import { getIO } from "../../lib/socket";
export class MarketRateService {
    fetchers = new Map();
    cache = new Map();
    stellarService;
    CACHE_DURATION_MS = 30000; // 30 seconds
    constructor() {
        this.stellarService = new StellarService();
        this.initializeFetchers();
    }
    initializeFetchers() {
        const kesFetcher = new KESRateFetcher();
        const ghsFetcher = new GHSRateFetcher();
        const ngnFetcher = new NGNRateFetcher();
        this.fetchers.set("KES", kesFetcher);
        this.fetchers.set("GHS", ghsFetcher);
        this.fetchers.set("NGN", ngnFetcher);
    }
    async getRate(currency) {
        try {
            const fetcher = this.fetchers.get(currency.toUpperCase());
            if (!fetcher) {
                return {
                    success: false,
                    error: `No fetcher available for currency: ${currency}`,
                };
            }
            // Check cache first
            const cached = this.cache.get(currency.toUpperCase());
            if (cached && cached.expiry > new Date()) {
                return {
                    success: true,
                    data: cached.rate,
                };
            }
            // Fetch fresh rate
            const rate = await fetcher.fetchRate();
            // Submit price update to Stellar with a unique memo ID
            try {
                const memoId = this.stellarService.generateMemoId(currency.toUpperCase());
                await this.stellarService.submitPriceUpdate(currency.toUpperCase(), rate.rate, memoId);
            }
            catch (stellarError) {
                console.error("Failed to submit price update to Stellar network:", stellarError);
            }
            // Update cache
            this.cache.set(currency.toUpperCase(), {
                rate,
                expiry: new Date(Date.now() + this.CACHE_DURATION_MS),
            });
            // Broadcast fresh price to all connected dashboard clients
            try {
                getIO().emit("price:update", { currency: currency.toUpperCase(), rate });
            }
            catch {
                // Socket not initialized yet (e.g. during tests) — skip silently
            }
            return {
                success: true,
                data: rate,
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error occurred",
            };
        }
    }
    async getAllRates() {
        const currencies = Array.from(this.fetchers.keys());
        const promises = currencies.map((currency) => this.getRate(currency));
        return Promise.all(promises);
    }
    async healthCheck() {
        const results = {};
        for (const [currency, fetcher] of this.fetchers) {
            try {
                results[currency] = await fetcher.isHealthy();
            }
            catch (error) {
                results[currency] = false;
            }
        }
        return results;
    }
    getSupportedCurrencies() {
        return Array.from(this.fetchers.keys());
    }
    async getLatestPrices() {
        const results = await this.getAllRates();
        const successfulRates = results
            .filter((result) => result.success && result.data)
            .map((result) => result.data);
        const errorMessages = results
            .filter((result) => !result.success)
            .map((result) => result.error)
            .filter((error) => !!error);
        const allSuccessful = successfulRates.length > 0 && errorMessages.length === 0;
        return {
            success: allSuccessful,
            data: successfulRates,
            ...(errorMessages.length > 0 && { error: errorMessages[0] }),
            ...(errorMessages.length > 0 && { errors: errorMessages }),
        };
    }
    clearCache() {
        this.cache.clear();
    }
    getCacheStatus() {
        const status = {};
        for (const currency of this.fetchers.keys()) {
            const cached = this.cache.get(currency);
            if (cached && cached.expiry > new Date()) {
                status[currency] = {
                    cached: true,
                    expiry: cached.expiry,
                };
            }
            else {
                status[currency] = {
                    cached: false,
                };
            }
        }
        return status;
    }
}
//# sourceMappingURL=marketRateService.js.map