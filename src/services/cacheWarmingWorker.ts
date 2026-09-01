import { cacheService } from "../cache/CacheService";
import { CACHE_CONFIG, CACHE_KEYS } from "../config/redis.config";
import { MarketRateService } from "./marketRate";
import { logger } from "../utils/logger";

/**
 * Cache Warming Worker for Market Endpoints (Issue #801)
 *
 * Pre-calculates heavily requested market summary data and stores warmed
 * JSON responses in Redis before client requests hit the API.
 *
 * Triggers:
 * - On new ledger arrival (via SorobanEventListener)
 * - On configurable interval (fallback)
 *
 * Warmed endpoints:
 * - GET /api/v1/market-rates/latest
 * - GET /api/v1/market-rates/rates
 * - GET /api/v1/market-rates/currencies
 * - GET /api/v1/market-rates/health
 * - GET /api/v1/market-rates/cache
 */

interface CacheWarmingConfig {
  /** Interval between periodic warming cycles (ms) */
  warmingIntervalMs: number;
  /** Whether to warm on new ledger arrival */
  warmOnLedger: boolean;
  /** Maximum concurrent warming tasks */
  maxConcurrency: number;
  /** Timeout for individual warming tasks (ms) */
  taskTimeoutMs: number;
}

const DEFAULT_CONFIG: CacheWarmingConfig = {
  warmingIntervalMs: 30_000, // 30 seconds
  warmOnLedger: true,
  maxConcurrency: 4,
  taskTimeoutMs: 5_000,
};

interface WarmingMetrics {
  totalCycles: number;
  ledgerTriggeredCycles: number;
  intervalTriggeredCycles: number;
  successfulWarmedKeys: number;
  failedWarmedKeys: number;
  averageCycleDurationMs: number;
  lastWarmingCycleAt: Date | null;
  lastLedgerTriggeredAt: Date | null;
}

export class CacheWarmingWorker {
  private config: CacheWarmingConfig;
  private marketRateService: MarketRateService;
  private warmTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isWarming = false;
  private metrics: WarmingMetrics;
  private cycleDurations: number[] = [];

  constructor(config?: Partial<CacheWarmingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.marketRateService = new MarketRateService();
    this.metrics = {
      totalCycles: 0,
      ledgerTriggeredCycles: 0,
      intervalTriggeredCycles: 0,
      successfulWarmedKeys: 0,
      failedWarmedKeys: 0,
      averageCycleDurationMs: 0,
      lastWarmingCycleAt: null,
      lastLedgerTriggeredAt: null,
    };
  }

  /**
   * Start the cache warming worker with periodic interval warming.
   */
  start(): void {
    if (this.isRunning) {
      logger.warn("[CacheWarmingWorker] Already running");
      return;
    }

    this.isRunning = true;

    // Initial warming cycle
    void this.runWarmingCycle("interval");

    // Start periodic warming
    this.warmTimer = setInterval(() => {
      void this.runWarmingCycle("interval");
    }, this.config.warmingIntervalMs);

    logger.info(
      `[CacheWarmingWorker] Started with ${this.config.warmingIntervalMs}ms interval`,
    );
  }

  /**
   * Stop the cache warming worker.
   */
  stop(): void {
    if (this.warmTimer) {
      clearInterval(this.warmTimer);
      this.warmTimer = null;
    }
    this.isRunning = false;
    logger.info("[CacheWarmingWorker] Stopped");
  }

  /**
   * Trigger a warming cycle on new ledger arrival.
   * Called by SorobanEventListener when a new ledger is confirmed.
   */
  async onNewLedger(ledgerSeq: number): Promise<void> {
    if (!this.config.warmOnLedger) return;
    if (!this.isRunning) return;

    logger.debug(
      `[CacheWarmingWorker] Ledger ${ledgerSeq} received, triggering warming`,
    );
    this.metrics.lastLedgerTriggeredAt = new Date();
    await this.runWarmingCycle("ledger");
  }

  /**
   * Run a complete warming cycle.
   */
  private async runWarmingCycle(trigger: "ledger" | "interval"): Promise<void> {
    if (this.isWarming) {
      logger.debug(
        "[CacheWarmingWorker] Warming already in progress, skipping",
      );
      return;
    }

    this.isWarming = true;
    const startTime = Date.now();

    try {
      this.metrics.totalCycles++;
      if (trigger === "ledger") {
        this.metrics.ledgerTriggeredCycles++;
      } else {
        this.metrics.intervalTriggeredCycles++;
      }

      // Run warming tasks concurrently with limit
      const tasks: Array<() => Promise<void>> = [
        () => this.warmLatestPrices(),
        () => this.warmAllRates(),
        () => this.warmCurrencies(),
        () => this.warmHealthCheck(),
        () => this.warmCacheStatus(),
      ];

      await this.runWithConcurrency(tasks, this.config.maxConcurrency);

      const duration = Date.now() - startTime;
      this.cycleDurations.push(duration);

      // Keep only last 100 durations for average calculation
      if (this.cycleDurations.length > 100) {
        this.cycleDurations.shift();
      }

      this.metrics.averageCycleDurationMs =
        this.cycleDurations.reduce((a, b) => a + b, 0) /
        this.cycleDurations.length;
      this.metrics.lastWarmingCycleAt = new Date();

      logger.info(
        `[CacheWarmingWorker] Cycle completed in ${duration}ms (trigger: ${trigger})`,
      );
    } catch (error) {
      logger.error("[CacheWarmingWorker] Warming cycle failed:", error);
    } finally {
      this.isWarming = false;
    }
  }

  /**
   * Run tasks with concurrency limit.
   */
  private async runWithConcurrency(
    tasks: Array<() => Promise<void>>,
    maxConcurrency: number,
  ): Promise<void> {
    const executing: Promise<void>[] = [];

    for (const task of tasks) {
      const promise = task().catch((error) => {
        logger.error("[CacheWarmingWorker] Task failed:", error);
      });

      executing.push(promise);

      if (executing.length >= maxConcurrency) {
        await Promise.race(executing);
        // Remove resolved promises
        for (let i = executing.length - 1; i >= 0; i--) {
          const result = await Promise.race([
            executing[i]!.then(() => true),
            Promise.resolve(false),
          ]);
          if (result) {
            executing.splice(i, 1);
          }
        }
      }
    }

    await Promise.allSettled(executing);
  }

  /**
   * Warm the latest prices cache.
   */
  private async warmLatestPrices(): Promise<void> {
    const cacheKey = CACHE_KEYS.marketRates.latest();
    const ttl = CACHE_CONFIG.ttl.marketRates;

    try {
      const result = await this.withTimeout(
        this.marketRateService.getLatestPrices(),
        this.config.taskTimeoutMs,
      );

      if (result.success && result.data) {
        await cacheService.set(cacheKey, result, ttl);
        this.metrics.successfulWarmedKeys++;
        logger.debug("[CacheWarmingWorker] Warmed latest prices");
      } else {
        logger.debug(
          "[CacheWarmingWorker] Latest prices not available for warming",
        );
      }
    } catch (error) {
      this.metrics.failedWarmedKeys++;
      logger.warn("[CacheWarmingWorker] Failed to warm latest prices:", error);
    }
  }

  /**
   * Warm the all rates cache.
   */
  private async warmAllRates(): Promise<void> {
    const cacheKey = CACHE_KEYS.marketRates.all();
    const ttl = CACHE_CONFIG.ttl.marketRates;

    try {
      const results = await this.withTimeout(
        this.marketRateService.getAllRates(),
        this.config.taskTimeoutMs,
      );

      const rates = results
        .filter((result) => result.success)
        .map((result) => result.data);

      const response = { success: true, data: rates };

      await cacheService.set(cacheKey, response, ttl);
      this.metrics.successfulWarmedKeys++;
      logger.debug("[CacheWarmingWorker] Warmed all rates");
    } catch (error) {
      this.metrics.failedWarmedKeys++;
      logger.warn("[CacheWarmingWorker] Failed to warm all rates:", error);
    }
  }

  /**
   * Warm the currencies cache.
   */
  private async warmCurrencies(): Promise<void> {
    const cacheKey = CACHE_KEYS.marketRates.currencies();
    const ttl = CACHE_CONFIG.ttl.marketRates;

    try {
      const currencies = this.marketRateService.getSupportedCurrencies();
      const response = { success: true, data: currencies };

      await cacheService.set(cacheKey, response, ttl);
      this.metrics.successfulWarmedKeys++;
      logger.debug("[CacheWarmingWorker] Warmed currencies");
    } catch (error) {
      this.metrics.failedWarmedKeys++;
      logger.warn("[CacheWarmingWorker] Failed to warm currencies:", error);
    }
  }

  /**
   * Warm the health check cache.
   */
  private async warmHealthCheck(): Promise<void> {
    const cacheKey = CACHE_KEYS.marketRates.health();
    const ttl = 60; // 1 minute for health checks

    try {
      const health = await this.withTimeout(
        this.marketRateService.healthCheck(),
        this.config.taskTimeoutMs,
      );

      const response = {
        success: true,
        data: health,
        overallHealthy: Object.values(health).every((status) => status),
      };

      await cacheService.set(cacheKey, response, ttl);
      this.metrics.successfulWarmedKeys++;
      logger.debug("[CacheWarmingWorker] Warmed health check");
    } catch (error) {
      this.metrics.failedWarmedKeys++;
      logger.warn("[CacheWarmingWorker] Failed to warm health check:", error);
    }
  }

  /**
   * Warm the cache status endpoint.
   */
  private async warmCacheStatus(): Promise<void> {
    const cacheKey = "market-rates:cache-status";
    const ttl = 30; // 30 seconds for cache status

    try {
      const cacheStatus = this.marketRateService.getCacheStatus();
      const response = { success: true, data: cacheStatus };

      await cacheService.set(cacheKey, response, ttl);
      this.metrics.successfulWarmedKeys++;
      logger.debug("[CacheWarmingWorker] Warmed cache status");
    } catch (error) {
      this.metrics.failedWarmedKeys++;
      logger.warn("[CacheWarmingWorker] Failed to warm cache status:", error);
    }
  }

  /**
   * Execute a promise with a timeout.
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Get current warming metrics.
   */
  getMetrics(): WarmingMetrics {
    return { ...this.metrics };
  }

  /**
   * Check if the worker is running.
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Check if a warming cycle is currently in progress.
   */
  isWarmingCycle(): boolean {
    return this.isWarming;
  }
}

// Singleton instance
let workerInstance: CacheWarmingWorker | null = null;

/**
 * Get or create the singleton cache warming worker.
 */
export function getCacheWarmingWorker(
  config?: Partial<CacheWarmingConfig>,
): CacheWarmingWorker {
  if (!workerInstance) {
    workerInstance = new CacheWarmingWorker(config);
  }
  return workerInstance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetCacheWarmingWorker(): void {
  if (workerInstance) {
    workerInstance.stop();
    workerInstance = null;
  }
}
