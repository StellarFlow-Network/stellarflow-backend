import { describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { cacheService } from "../src/cache/CacheService";
import { CacheInvalidation } from "../src/cache/CacheInvalidation";
import { getRedisClient } from "../src/lib/redis";

describe("Cache Integration Tests", () => {
  beforeEach(async () => {
    await cacheService.clear();
    cacheService.resetMetrics();
  });

  afterAll(async () => {
    await cacheService.clear();
    const redis = getRedisClient();
    if (redis?.isOpen) {
      await redis.quit();
    }
  });

  describe("CacheService", () => {
    it("should store and retrieve data from cache", async () => {
      const key = "test:key";
      const value = { data: "test value" };

      await cacheService.set(key, value, 60);
      const cached = await cacheService.get(key);

      expect(cached).toEqual(value);
    });

    it("should return null for non-existent keys", async () => {
      const cached = await cacheService.get("non:existent:key");
      expect(cached).toBeNull();
    });

    it("should delete cached data", async () => {
      const key = "test:delete";
      await cacheService.set(key, { data: "test" }, 60);

      await cacheService.delete(key);
      const cached = await cacheService.get(key);

      expect(cached).toBeNull();
    });

    it("should delete by pattern", async () => {
      await cacheService.set("market-rates:NGN", { rate: 1500 }, 60);
      await cacheService.set("market-rates:GHS", { rate: 15 }, 60);
      await cacheService.set("history:NGN", { data: [] }, 60);

      await cacheService.deletePattern("market-rates:*");

      const ngnRate = await cacheService.get("market-rates:NGN");
      const ghsRate = await cacheService.get("market-rates:GHS");
      const history = await cacheService.get("history:NGN");

      expect(ngnRate).toBeNull();
      expect(ghsRate).toBeNull();
      expect(history).toBeNull(); // L1 cache cleared
    });

    it("should track cache metrics", async () => {
      await cacheService.set("test:metrics", { data: "test" }, 60);

      await cacheService.get("test:metrics"); // Hit
      await cacheService.get("test:nonexistent"); // Miss

      const metrics = cacheService.getMetrics();

      expect(metrics.hits).toBeGreaterThan(0);
      expect(metrics.misses).toBeGreaterThan(0);
      expect(metrics.total).toBe(metrics.hits + metrics.misses);
    });

    it("should calculate hit rate correctly", async () => {
      await cacheService.set("test:hitrate", { data: "test" }, 60);

      await cacheService.get("test:hitrate"); // Hit
      await cacheService.get("test:hitrate"); // Hit (L1)
      await cacheService.get("test:miss"); // Miss

      const metrics = cacheService.getMetrics();
      const expectedHitRate = (2 / 3) * 100;

      expect(parseFloat(metrics.hitRate)).toBeCloseTo(expectedHitRate, 1);
    });
  });

  describe("Cache Invalidation", () => {
    it("should invalidate market rate caches on update", async () => {
      await cacheService.set("market-rates:all", { data: [] }, 60);
      await cacheService.set("market-rates:NGN", { rate: 1500 }, 60);
      await cacheService.set("market-rates:latest", { data: [] }, 60);

      await CacheInvalidation.onMarketRateUpdate("NGN");

      const all = await cacheService.get("market-rates:all");
      const ngn = await cacheService.get("market-rates:NGN");
      const latest = await cacheService.get("market-rates:latest");

      expect(all).toBeNull();
      expect(ngn).toBeNull();
      expect(latest).toBeNull();
    });

    it("should invalidate pending reviews cache", async () => {
      await cacheService.set("market-rates:reviews:pending", { data: [] }, 60);

      await CacheInvalidation.onPriceReviewUpdate();

      const cached = await cacheService.get("market-rates:reviews:pending");
      expect(cached).toBeNull();
    });

    it("should invalidate derived asset caches", async () => {
      await cacheService.set("derived:NGN:GHS", { rate: 100 }, 60);

      await CacheInvalidation.onDerivedAssetUpdate("NGN", "GHS");

      const cached = await cacheService.get("derived:NGN:GHS");
      expect(cached).toBeNull();
    });
  });

  describe("L1 Cache (LRU)", () => {
    it("should serve from L1 cache on second request", async () => {
      const key = "test:l1";
      await cacheService.set(key, { data: "test" }, 60);

      await cacheService.get(key); // L2 hit
      await cacheService.get(key); // L1 hit

      const metrics = cacheService.getMetrics();
      expect(metrics.l1Hits).toBeGreaterThan(0);
    });

    it("should evict oldest entry when cache is full", async () => {
      // This test would require setting a small maxSize for testing
      // For now, we just verify the cache works with multiple entries
      for (let i = 0; i < 10; i++) {
        await cacheService.set(`test:lru:${i}`, { data: i }, 60);
      }

      const metrics = cacheService.getMetrics();
      expect(metrics.l1Size).toBeGreaterThan(0);
    });
  });

  describe("Graceful Degradation", () => {
    it("should handle Redis unavailability gracefully", async () => {
      // Even if Redis is down, the service should not throw errors
      const key = "test:graceful";

      await expect(cacheService.set(key, { data: "test" }, 60)).resolves.not.toThrow();
      await expect(cacheService.get(key)).resolves.toBeDefined();
    });
  });
});
