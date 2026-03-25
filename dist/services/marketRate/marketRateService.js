import { KESRateFetcher } from './kesFetcher';
import { GHSRateFetcher } from './ghsFetcher';
export class MarketRateService {
    fetchers = new Map();
    cache = new Map();
    CACHE_DURATION_MS = 30000; // 30 seconds
    constructor() {
        this.initializeFetchers();
    }
    initializeFetchers() {
        const kesFetcher = new KESRateFetcher();
        const ghsFetcher = new GHSRateFetcher();
        this.fetchers.set('KES', kesFetcher);
        this.fetchers.set('GHS', ghsFetcher);
    }
    async getRate(currency) {
        try {
            const fetcher = this.fetchers.get(currency.toUpperCase());
            if (!fetcher) {
                return {
                    success: false,
                    error: `No fetcher available for currency: ${currency}`
                };
            }
            // Check cache first
            const cached = this.cache.get(currency.toUpperCase());
            if (cached && cached.expiry > new Date()) {
                return {
                    success: true,
                    data: cached.rate
                };
            }
            // Fetch fresh rate
            const rate = await fetcher.fetchRate();
            // Update cache
            this.cache.set(currency.toUpperCase(), {
                rate,
                expiry: new Date(Date.now() + this.CACHE_DURATION_MS)
            });
            return {
                success: true,
                data: rate
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error occurred'
            };
        }
    }
    async getAllRates() {
        const currencies = Array.from(this.fetchers.keys());
        const promises = currencies.map(currency => this.getRate(currency));
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
                    expiry: cached.expiry
                };
            }
            else {
                status[currency] = {
                    cached: false
                };
            }
        }
        return status;
    }
}
//# sourceMappingURL=marketRateService.js.map