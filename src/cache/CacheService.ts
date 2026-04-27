import { getRedisClient } from "../lib/redis";
import { CACHE_CONFIG } from "../config/redis.config";

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.data;
  }

  set(key: string, value: T, ttlSeconds: number): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      data: value,
      expiry: Date.now() + ttlSeconds * 1000,
    });
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export class CacheService {
  private l1Cache: LRUCache<any>;
  private metrics = {
    hits: 0,
    misses: 0,
    l1Hits: 0,
    l2Hits: 0,
    errors: 0,
  };

  constructor() {
    this.l1Cache = new LRUCache(CACHE_CONFIG.l1.maxSize);
  }

  async get<T>(key: string): Promise<T | null> {
    const prefixedKey = this.getPrefixedKey(key);

    // L1 Cache check
    if (CACHE_CONFIG.l1.enabled) {
      const l1Data = this.l1Cache.get(prefixedKey);
      if (l1Data !== null) {
        this.metrics.hits++;
        this.metrics.l1Hits++;
        return l1Data as T;
      }
    }

    // L2 Cache (Redis) check
    const redis = getRedisClient();
    if (!redis?.isOpen) {
      this.metrics.misses++;
      return null;
    }

    try {
      const cached = await redis.get(prefixedKey);
      if (cached) {
        const data = JSON.parse(cached) as T;

        // Populate L1 cache
        if (CACHE_CONFIG.l1.enabled) {
          this.l1Cache.set(prefixedKey, data, CACHE_CONFIG.l1.ttl);
        }

        this.metrics.hits++;
        this.metrics.l2Hits++;
        return data;
      }

      this.metrics.misses++;
      return null;
    } catch (error) {
      this.metrics.errors++;
      console.error("[CacheService] Get error:", error);
      return null;
    }
  }

  async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    const prefixedKey = this.getPrefixedKey(key);

    // Set in L1 cache
    if (CACHE_CONFIG.l1.enabled) {
      this.l1Cache.set(prefixedKey, value, CACHE_CONFIG.l1.ttl);
    }

    // Set in L2 cache (Redis)
    const redis = getRedisClient();
    if (!redis?.isOpen) return;

    try {
      await redis.setEx(prefixedKey, ttlSeconds, JSON.stringify(value));
    } catch (error) {
      this.metrics.errors++;
      console.error("[CacheService] Set error:", error);
    }
  }

  async delete(key: string): Promise<void> {
    const prefixedKey = this.getPrefixedKey(key);

    // Delete from L1
    this.l1Cache.delete(prefixedKey);

    // Delete from L2
    const redis = getRedisClient();
    if (!redis?.isOpen) return;

    try {
      await redis.del(prefixedKey);
    } catch (error) {
      this.metrics.errors++;
      console.error("[CacheService] Delete error:", error);
    }
  }

  async deletePattern(pattern: string): Promise<void> {
    const prefixedPattern = this.getPrefixedKey(pattern);

    // Clear L1 cache entirely (pattern matching not efficient for LRU)
    this.l1Cache.clear();

    // Delete from Redis by pattern
    const redis = getRedisClient();
    if (!redis?.isOpen) return;

    try {
      const keys = await redis.keys(prefixedPattern);
      if (keys.length > 0) {
        await redis.del(keys);
      }
    } catch (error) {
      this.metrics.errors++;
      console.error("[CacheService] Delete pattern error:", error);
    }
  }

  async clear(): Promise<void> {
    this.l1Cache.clear();

    const redis = getRedisClient();
    if (!redis?.isOpen) return;

    try {
      const keys = await redis.keys(`${CACHE_CONFIG.redis.keyPrefix}*`);
      if (keys.length > 0) {
        await redis.del(keys);
      }
    } catch (error) {
      this.metrics.errors++;
      console.error("[CacheService] Clear error:", error);
    }
  }

  getMetrics() {
    const total = this.metrics.hits + this.metrics.misses;
    const hitRate = total > 0 ? (this.metrics.hits / total) * 100 : 0;

    return {
      ...this.metrics,
      total,
      hitRate: `${hitRate.toFixed(2)}%`,
      l1Size: this.l1Cache.size(),
    };
  }

  resetMetrics(): void {
    this.metrics = {
      hits: 0,
      misses: 0,
      l1Hits: 0,
      l2Hits: 0,
      errors: 0,
    };
  }

  private getPrefixedKey(key: string): string {
    return `${CACHE_CONFIG.redis.keyPrefix}${key}`;
  }
}

export const cacheService = new CacheService();
