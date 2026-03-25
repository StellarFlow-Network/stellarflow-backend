import { MarketRateFetcher, MarketRate, FetcherResponse } from './types';
import { KESRateFetcher } from './kesFetcher';
import { GHSRateFetcher } from './ghsFetcher';

export class MarketRateService {
  private fetchers: Map<string, MarketRateFetcher> = new Map();
  private cache: Map<string, { rate: MarketRate; expiry: Date }> = new Map();
  private readonly CACHE_DURATION_MS = 30000; // 30 seconds

  constructor() {
    this.initializeFetchers();
  }

  private initializeFetchers(): void {
    const kesFetcher = new KESRateFetcher();
    const ghsFetcher = new GHSRateFetcher();

    this.fetchers.set('KES', kesFetcher);
    this.fetchers.set('GHS', ghsFetcher);
  }

  async getRate(currency: string): Promise<FetcherResponse> {
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
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      };
    }
  }

  async getAllRates(): Promise<FetcherResponse[]> {
    const currencies = Array.from(this.fetchers.keys());
    const promises = currencies.map(currency => this.getRate(currency));
    
    return Promise.all(promises);
  }

  async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};
    
    for (const [currency, fetcher] of this.fetchers) {
      try {
        results[currency] = await fetcher.isHealthy();
      } catch (error) {
        results[currency] = false;
      }
    }
    
    return results;
  }

  getSupportedCurrencies(): string[] {
    return Array.from(this.fetchers.keys());
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheStatus(): Record<string, { cached: boolean; expiry?: Date }> {
    const status: Record<string, { cached: boolean; expiry?: Date }> = {};
    
    for (const currency of this.fetchers.keys()) {
      const cached = this.cache.get(currency);
      if (cached && cached.expiry > new Date()) {
        status[currency] = {
          cached: true,
          expiry: cached.expiry
        };
      } else {
        status[currency] = {
          cached: false
        };
      }
    }
    
    return status;
  }
}
