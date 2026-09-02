import { getRedisClient } from "../lib/redis";
import { CACHE_CONFIG } from "../config/redis.config";
import { logger } from "../utils/logger";

/**
 * Cache Eviction & Memory Purger Worker (Issue #919)
 *
 * Prevents Redis cache bloat by automatically purging stale dynamic route
 * responses on a scheduled interval (default: every hour).
 *
 * Responsibilities:
 * - Scan the dynamic route response key namespace and delete expired keys.
 * - Monitor Redis heap memory usage and log reclaimed byte statistics.
 * - Use SCAN + DEL in batches (never FLUSHDB) to avoid cache corruption
 *   during active read operations.
 */

interface CacheEvictionConfig {
  /** Interval between eviction cycles (ms) */
  evictionIntervalMs: number;
  /** Batch size for SCAN/DEL operations */
  batchSize: number;
  /** Whether to run an initial eviction cycle on start */
  runOnStart: boolean;
}

const DEFAULT_CONFIG: CacheEvictionConfig = {
  evictionIntervalMs: 60 * 60 * 1000, // 1 hour
  batchSize: 500,
  runOnStart: true,
};

interface EvictionMetrics {
  totalCycles: number;
  totalKeysScanned: number;
  totalKeysDeleted: number;
  totalBytesReclaimed: number;
  lastCycleAt: Date | null;
  lastCycleDurationMs: number;
  lastCycleDeletedKeys: number;
  lastCycleBytesReclaimed: number;
  lastMemoryUsedBytes: number;
  lastMemoryPeakBytes: number;
}

export class CacheEvictionWorker {
  private config: CacheEvictionConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isEvicting = false;
  private metrics: EvictionMetrics;

  constructor(config?: Partial<CacheEvictionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = {
      totalCycles: 0,
      totalKeysScanned: 0,
      totalKeysDeleted: 0,
      totalBytesReclaimed: 0,
      lastCycleAt: null,
      lastCycleDurationMs: 0,
      lastCycleDeletedKeys: 0,
      lastCycleBytesReclaimed: 0,
      lastMemoryUsedBytes: 0,
      lastMemoryPeakBytes: 0,
    };
  }

  /**
   * Start the scheduled cache eviction worker.
   */
  start(): void {
    if (this.isRunning) {
      logger.warn("[CacheEvictionWorker] Already running");
      return;
    }

    this.isRunning = true;

    if (this.config.runOnStart) {
      void this.runEvictionCycle();
    }

    this.timer = setInterval(() => {
      void this.runEvictionCycle();
    }, this.config.evictionIntervalMs);

    logger.info(
      `[CacheEvictionWorker] Started with ${this.config.evictionIntervalMs}ms interval`,
    );
  }

  /**
   * Stop the cache eviction worker.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    logger.info("[CacheEvictionWorker] Stopped");
  }

  isActive(): boolean {
    return this.isRunning;
  }

  isEvictionCycle(): boolean {
    return this.isEvicting;
  }

  getMetrics(): EvictionMetrics {
    return { ...this.metrics };
  }

  /**
   * Run a single eviction cycle.
   *
   * Uses SCAN + DEL in batches to avoid blocking Redis and to ensure zero
   * cache corruption during active read operations. Only keys that have
   * already expired (no TTL remaining) are purged.
   */
  async runEvictionCycle(): Promise<void> {
    if (this.isEvicting) {
      logger.debug("[CacheEvictionWorker] Eviction already in progress, skipping");
      return;
    }

    const redis = getRedisClient();
    if (!redis?.isOpen) {
      logger.warn("[CacheEvictionWorker] Redis not available, skipping cycle");
      return;
    }

    this.isEvicting = true;
    const startTime = Date.now();
    const prefix = CACHE_CONFIG.redis.keyPrefix;

    try {
      // Capture memory before eviction
      const memoryBefore = await this.readMemoryInfo(redis);
      const usedBefore = memoryBefore.used_memory ?? 0;

      let scanned = 0;
      let deleted = 0;

      // Scan the dynamic route response namespace in batches.
      // The pattern matches all keys under the stellarflow: prefix that
      // represent dynamic route responses (e.g. stellarflow:market-rates:*,
      // stellarflow:history:*, stellarflow:stats:*, etc.).
      const pattern = `${prefix}*`;

      for await (const keys of redis.scanIterator({
        MATCH: pattern,
        COUNT: this.config.batchSize,
      })) {
        scanned += keys.length;

        // For each batch, delete only keys that have already expired.
        // We use PTTL to check remaining TTL; keys with TTL <= 0 are stale.
        const expiredKeys: string[] = [];
        for (const key of keys) {
          const ttl = await redis.ttl(key);
          if (ttl <= 0) {
            expiredKeys.push(key);
          }
        }

        if (expiredKeys.length > 0) {
          await redis.del(expiredKeys);
          deleted += expiredKeys.length;
        }
      }

      // Capture memory after eviction
      const memoryAfter = await this.readMemoryInfo(redis);
      const usedAfter = memoryAfter.used_memory ?? 0;
      const bytesReclaimed = Math.max(0, usedBefore - usedAfter);

      // Update metrics
      this.metrics.totalCycles++;
      this.metrics.totalKeysScanned += scanned;
      this.metrics.totalKeysDeleted += deleted;
      this.metrics.totalBytesReclaimed += bytesReclaimed;
      this.metrics.lastCycleAt = new Date();
      this.metrics.lastCycleDurationMs = Date.now() - startTime;
      this.metrics.lastCycleDeletedKeys = deleted;
      this.metrics.lastCycleBytesReclaimed = bytesReclaimed;
      this.metrics.lastMemoryUsedBytes = usedAfter;
      this.metrics.lastMemoryPeakBytes = memoryAfter.used_memory_peak ?? 0;

      logger.info(
        `[CacheEvictionWorker] Cycle complete: scanned=${scanned} deleted=${deleted} ` +
          `bytesReclaimed=${bytesReclaimed} durationMs=${Date.now() - startTime}`,
      );
    } catch (error) {
      logger.error("[CacheEvictionWorker] Eviction cycle failed:", error);
    } finally {
      this.isEvicting = false;
    }
  }

  /**
   * Read Redis memory info and return parsed metrics.
   */
  private async readMemoryInfo(
    redis: ReturnType<typeof getRedisClient>,
  ): Promise<Record<string, number>> {
    if (!redis) return {};
    const info = await redis.sendCommand(["INFO", "memory"]);
    return Object.fromEntries(
      String(info)
        .split("\r\n")
        .flatMap((line) => {
          const index = line.indexOf(":");
          if (index < 0) return [];
          const value = Number(line.slice(index + 1));
          return Number.isFinite(value)
            ? [[line.slice(0, index), value]]
            : [];
        }),
    );
  }
}

let workerInstance: CacheEvictionWorker | null = null;

export function getCacheEvictionWorker(
  config?: Partial<CacheEvictionConfig>,
): CacheEvictionWorker {
  if (!workerInstance) {
    workerInstance = new CacheEvictionWorker(config);
  }
  return workerInstance;
}

export function resetCacheEvictionWorker(): void {
  if (workerInstance) {
    workerInstance.stop();
    workerInstance = null;
  }
}
