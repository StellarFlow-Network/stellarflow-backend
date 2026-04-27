import { cacheService } from "./CacheService";
import { CACHE_KEYS } from "../config/redis.config";

export class CacheInvalidation {
  static async onMarketRateUpdate(currency?: string): Promise<void> {
    if (currency) {
      await cacheService.delete(CACHE_KEYS.marketRates.single(currency));
    }
    await cacheService.delete(CACHE_KEYS.marketRates.all());
    await cacheService.delete(CACHE_KEYS.marketRates.latest());
    await cacheService.deletePattern("history:*");
    await cacheService.deletePattern("stats:*");
  }

  static async onPriceReviewUpdate(): Promise<void> {
    await cacheService.delete(CACHE_KEYS.marketRates.pendingReviews());
  }

  static async onAssetUpdate(): Promise<void> {
    await cacheService.delete(CACHE_KEYS.assets.all());
    await cacheService.deletePattern("history:*");
  }

  static async onDerivedAssetUpdate(base?: string, quote?: string): Promise<void> {
    if (base && quote) {
      await cacheService.delete(CACHE_KEYS.derivedAssets.crossRate(base, quote));
    }
    await cacheService.deletePattern("derived:*");
  }

  static async onStatsUpdate(): Promise<void> {
    await cacheService.deletePattern("stats:*");
  }

  static async clearAll(): Promise<void> {
    await cacheService.clear();
  }
}
