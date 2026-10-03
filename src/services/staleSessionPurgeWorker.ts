import { getRedisClient } from "../lib/redis";
import { hasActiveSessionConnection } from "../lib/sessionConnectionRegistry";
import { logger } from "../utils/logger";
import {
  SESSION_KEY_PREFIX,
  decryptSessionPayload,
  parseSessionKey,
} from "../utils/jwt";

/**
 * Stale Session Purge Service (Issue #1054)
 *
 * Automatically identifies and purges abandoned user session keys from Redis.
 *
 * Responsibilities:
 * - Walk the `stellarflow:sessions:*` namespace with the SCAN cursor so Redis
 *   never blocks its main thread on a KEYS-style enumeration.
 * - Delete session tokens whose Redis TTL or embedded expiry has elapsed and
 *   that do not own an active WebSocket connection.
 * - Log the number of purged stale sessions on each hourly execution.
 */

/** `TTL` response for a key that no longer exists. */
const KEY_MISSING = -2;
/** `TTL` response for a key that has no expiry attached. */
const KEY_NO_EXPIRY = -1;

interface StaleSessionPurgeConfig {
  /** Interval between purge cycles (ms) */
  purgeIntervalMs: number;
  /** Batch size for SCAN/DEL operations */
  batchSize: number;
  /** Whether to run an initial purge cycle on start */
  runOnStart: boolean;
}

const DEFAULT_CONFIG: StaleSessionPurgeConfig = {
  purgeIntervalMs: 60 * 60 * 1000, // 1 hour
  batchSize: 500,
  runOnStart: true,
};

export interface PurgeCycleSummary {
  scanned: number;
  purged: number;
  durationMs: number;
}

export interface StaleSessionPurgeMetrics {
  totalCycles: number;
  totalKeysScanned: number;
  totalSessionsPurged: number;
  lastCycleAt: Date | null;
  lastCycleDurationMs: number;
  lastCycleScanned: number;
  lastCyclePurged: number;
}

export class StaleSessionPurgeWorker {
  private config: StaleSessionPurgeConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isPurging = false;
  private metrics: StaleSessionPurgeMetrics;

  constructor(config?: Partial<StaleSessionPurgeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = {
      totalCycles: 0,
      totalKeysScanned: 0,
      totalSessionsPurged: 0,
      lastCycleAt: null,
      lastCycleDurationMs: 0,
      lastCycleScanned: 0,
      lastCyclePurged: 0,
    };
  }

  /**
   * Start the scheduled stale session purge worker (hourly by default).
   */
  start(): void {
    if (this.isRunning) {
      logger.warn("[StaleSessionPurgeWorker] Already running");
      return;
    }

    this.isRunning = true;

    if (this.config.runOnStart) {
      void this.runPurgeCycle();
    }

    this.timer = setInterval(() => {
      void this.runPurgeCycle();
    }, this.config.purgeIntervalMs);

    logger.info(
      `[StaleSessionPurgeWorker] Started with ${this.config.purgeIntervalMs}ms interval`,
    );
  }

  /**
   * Stop the scheduled stale session purge worker.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    logger.info("[StaleSessionPurgeWorker] Stopped");
  }

  isActive(): boolean {
    return this.isRunning;
  }

  isPurgeCycleRunning(): boolean {
    return this.isPurging;
  }

  getMetrics(): StaleSessionPurgeMetrics {
    return { ...this.metrics };
  }

  /**
   * Run a single purge cycle.
   *
   * Iterates the session namespace with SCAN (never KEYS) so the Redis main
   * thread stays responsive, then deletes every session whose token has
   * expired while no active WebSocket connection still claims it.
   *
   * @returns the cycle summary, or `null` when the cycle was skipped/failed.
   */
  async runPurgeCycle(): Promise<PurgeCycleSummary | null> {
    if (this.isPurging) {
      logger.debug(
        "[StaleSessionPurgeWorker] Purge already in progress, skipping",
      );
      return null;
    }

    const redis = getRedisClient();
    if (!redis?.isOpen) {
      logger.warn(
        "[StaleSessionPurgeWorker] Redis not available, skipping cycle",
      );
      return null;
    }

    this.isPurging = true;
    const startTime = Date.now();
    const pattern = `${SESSION_KEY_PREFIX}*`;
    let scanned = 0;
    let purged = 0;

    try {
      for await (const keys of redis.scanIterator({
        MATCH: pattern,
        COUNT: this.config.batchSize,
      })) {
        scanned += keys.length;

        const staleKeys: string[] = [];
        for (const key of keys) {
          if (await this.isStaleSession(key)) {
            staleKeys.push(key);
          }
        }

        if (staleKeys.length > 0) {
          purged += await redis.del(staleKeys);
        }
      }

      const summary: PurgeCycleSummary = {
        scanned,
        purged,
        durationMs: Date.now() - startTime,
      };

      this.metrics.totalCycles++;
      this.metrics.totalKeysScanned += summary.scanned;
      this.metrics.totalSessionsPurged += summary.purged;
      this.metrics.lastCycleAt = new Date();
      this.metrics.lastCycleDurationMs = summary.durationMs;
      this.metrics.lastCycleScanned = summary.scanned;
      this.metrics.lastCyclePurged = summary.purged;

      logger.info(
        `[StaleSessionPurgeWorker] Purge cycle complete: purged=${summary.purged} ` +
          `scanned=${summary.scanned} durationMs=${summary.durationMs}`,
      );

      return summary;
    } catch (error) {
      logger.error("[StaleSessionPurgeWorker] Purge cycle failed:", error);
      return null;
    } finally {
      this.isPurging = false;
    }
  }

  /**
   * A session is stale when its token has expired (either Redis reports no
   * remaining TTL or the stored payload is past its expiry) and no active
   * WebSocket connection still claims it.
   */
  private async isStaleSession(key: string): Promise<boolean> {
    const redis = getRedisClient();
    if (!redis) return false;

    const ttl = await redis.ttl(key);
    if (ttl === KEY_MISSING) return false;

    const session = parseSessionKey(key);
    if (session && hasActiveSessionConnection(session.sid)) return false;

    if (ttl !== KEY_NO_EXPIRY && ttl <= 0) return true;

    const encryptedPayload = await redis.get(key);
    if (!encryptedPayload) return false;

    return this.isPayloadExpired(encryptedPayload);
  }

  /**
   * Decode the encrypted session record and report whether it is past its
   * expiry. Payloads that cannot be decoded are retained: a purge must never
   * destroy records it cannot inspect.
   */
  private isPayloadExpired(encryptedPayload: string): boolean {
    try {
      const record = decryptSessionPayload(encryptedPayload);

      if (typeof record.exp === "number" && record.exp > 0) {
        return Date.now() / 1000 > record.exp;
      }

      if (record.expiresAt) {
        const expiresAtMs = Date.parse(record.expiresAt);
        if (Number.isFinite(expiresAtMs)) return Date.now() > expiresAtMs;
      }

      return false;
    } catch {
      return false;
    }
  }
}

let workerInstance: StaleSessionPurgeWorker | null = null;

export function getStaleSessionPurgeWorker(
  config?: Partial<StaleSessionPurgeConfig>,
): StaleSessionPurgeWorker {
  if (!workerInstance) {
    workerInstance = new StaleSessionPurgeWorker(config);
  }
  return workerInstance;
}

export function resetStaleSessionPurgeWorker(): void {
  if (workerInstance) {
    workerInstance.stop();
    workerInstance = null;
  }
}
