import { getRedisClient } from "../lib/redis";
import { logger } from "../utils/logger";

/**
 * High-Frequency Order Book Snapshot Engine (Issue #796)
 *
 * Responsibilities:
 * - Maintains an in-memory order book depth state (bids/asks keyed by price).
 * - Captures periodic snapshots of the in-memory order book every
 *   `snapshotIntervalLedgers` (default 100) ledgers.
 * - Persists snapshots to Redis so worker processes can recover their order
 *   book state quickly after a restart, instead of rebuilding from scratch.
 * - Purges snapshots that exceed the retention window (default 7 days).
 */

export type OrderSide = "bid" | "ask";

export interface OrderBookLevel {
  price: number;
  amount: number;
}

export interface OrderBookSnapshot {
  version: number;
  ledgerSeq: number;
  capturedAt: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface OrderBookSnapshotEngineConfig {
  /** Capture a snapshot every N ledgers */
  snapshotIntervalLedgers: number;
  /** Snapshots older than this many days are purged */
  retentionDays: number;
  /** How often the purge job runs (ms) */
  purgeIntervalMs: number;
  /** Redis key namespace (full key prefix) */
  keyPrefix: string;
}

const DEFAULT_CONFIG: OrderBookSnapshotEngineConfig = {
  snapshotIntervalLedgers: 10,
  retentionDays: 7,
  purgeIntervalMs: 60 * 60 * 1000, // 1 hour
  keyPrefix: "stellarflow:orderbook:snapshot",
};

interface SnapshotMetrics {
  snapshotsCaptured: number;
  snapshotsRecovered: number;
  snapshotsPurged: number;
  lastSnapshotLedger: number | null;
  lastSnapshotAt: Date | null;
  lastRecoveryAt: Date | null;
  lastPurgeAt: Date | null;
  captureErrors: number;
  recoveryErrors: number;
}

export class OrderBookSnapshotEngine {
  private config: OrderBookSnapshotEngineConfig;
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private lastSnapshotLedger = 0;
  private isCapturing = false;
  private purgeTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private metrics: SnapshotMetrics;

  constructor(config?: Partial<OrderBookSnapshotEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = {
      snapshotsCaptured: 0,
      snapshotsRecovered: 0,
      snapshotsPurged: 0,
      lastSnapshotLedger: null,
      lastSnapshotAt: null,
      lastRecoveryAt: null,
      lastPurgeAt: null,
      captureErrors: 0,
      recoveryErrors: 0,
    };
  }

  /** Apply a depth update to the in-memory order book. */
  applyDepthUpdate(side: OrderSide, price: number, amount: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const book = side === "bid" ? this.bids : this.asks;
    if (amount <= 0) {
      book.delete(price);
      return;
    }
    book.set(price, (book.get(price) ?? 0) + amount);
  }

  /** Set the amount at a price level, replacing any existing value. */
  setLevel(side: OrderSide, price: number, amount: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const book = side === "bid" ? this.bids : this.asks;
    if (amount <= 0) {
      book.delete(price);
      return;
    }
    book.set(price, amount);
  }

  /** Remove a price level entirely. */
  removeLevel(side: OrderSide, price: number): void {
    const book = side === "bid" ? this.bids : this.asks;
    book.delete(price);
  }

  /** Clear the in-memory order book. */
  clear(): void {
    this.bids.clear();
    this.asks.clear();
  }

  /** Number of active price levels in the in-memory book. */
  get levelCount(): number {
    return this.bids.size + this.asks.size;
  }

  /** Returns the current in-memory order depth (bids descending, asks ascending). */
  getDepth(): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } {
    return {
      bids: [...this.bids.entries()]
        .map(([price, amount]) => ({ price, amount }))
        .sort((a, b) => b.price - a.price),
      asks: [...this.asks.entries()]
        .map(([price, amount]) => ({ price, amount }))
        .sort((a, b) => a.price - b.price),
    };
  }

  /**
   * Called on each new ledger arrival. Captures a snapshot every
   * `snapshotIntervalLedgers` ledgers.
   */
  async onNewLedger(ledgerSeq: number): Promise<void> {
    if (!this.isRunning) return;
    if (
      ledgerSeq - this.lastSnapshotLedger <
      this.config.snapshotIntervalLedgers
    ) {
      return;
    }
    await this.captureSnapshot(ledgerSeq);
  }

  /**
   * Serialize the current in-memory order book to persistent storage (Redis).
   */
  async captureSnapshot(ledgerSeq: number): Promise<OrderBookSnapshot | null> {
    if (this.isCapturing) {
      logger.debug(
        "[OrderBookSnapshotEngine] Capture already in progress, skipping",
      );
      return null;
    }

    this.isCapturing = true;
    try {
      const snapshot: OrderBookSnapshot = {
        version: 1,
        ledgerSeq,
        capturedAt: new Date().toISOString(),
        ...this.getDepth(),
      };

      const snapshotKey = `${this.config.keyPrefix}:${ledgerSeq}`;
      const latestKey = `${this.config.keyPrefix}:latest`;
      const ttlSeconds = this.config.retentionDays * 24 * 60 * 60;

      const redis = getRedisClient();
      if (redis?.isOpen) {
        await redis.setEx(snapshotKey, ttlSeconds, JSON.stringify(snapshot));
        await redis.setEx(latestKey, ttlSeconds, String(ledgerSeq));
      } else {
        logger.warn(
          "[OrderBookSnapshotEngine] Redis unavailable; snapshot persisted in-memory only",
        );
      }

      this.lastSnapshotLedger = ledgerSeq;
      this.metrics.snapshotsCaptured++;
      this.metrics.lastSnapshotLedger = ledgerSeq;
      this.metrics.lastSnapshotAt = new Date();

      logger.info(
        `[OrderBookSnapshotEngine] Snapshot captured at ledger ${ledgerSeq} ` +
          `(${this.bids.size} bid levels, ${this.asks.size} ask levels)`,
      );

      try {
        const { getOrderBookDepthSnapshotExporter } = await import(
          "./orderBookDepthSnapshotExporter"
        );
        await getOrderBookDepthSnapshotExporter().exportSnapshot(snapshot);
      } catch (error) {
        logger.warn(
          "[OrderBookSnapshotEngine] Snapshot export to analytics storage failed:",
          error,
        );
      }

      return snapshot;
    } catch (error) {
      this.metrics.captureErrors++;
      logger.error(
        "[OrderBookSnapshotEngine] Failed to capture snapshot:",
        error,
      );
      return null;
    } finally {
      this.isCapturing = false;
    }
  }

  /**
   * Recover the in-memory order book from the latest persisted snapshot.
   * Called on worker start to accelerate restart recovery.
   */
  async recoverFromLatestSnapshot(): Promise<OrderBookSnapshot | null> {
    try {
      const redis = getRedisClient();
      if (!redis?.isOpen) return null;

      const latestKey = `${this.config.keyPrefix}:latest`;
      const latestLedgerRaw = await redis.get(latestKey);
      if (!latestLedgerRaw) return null;

      const snapshotKey = `${this.config.keyPrefix}:${latestLedgerRaw}`;
      const raw = await redis.get(snapshotKey);
      if (!raw) return null;

      const snapshot = JSON.parse(raw) as OrderBookSnapshot;
      this.applySnapshot(snapshot);
      this.lastSnapshotLedger = snapshot.ledgerSeq;
      this.metrics.snapshotsRecovered++;
      this.metrics.lastSnapshotLedger = snapshot.ledgerSeq;
      this.metrics.lastRecoveryAt = new Date();

      logger.info(
        `[OrderBookSnapshotEngine] Recovered order book from ledger ${snapshot.ledgerSeq} ` +
          `(${this.bids.size} bid levels, ${this.asks.size} ask levels)`,
      );
      return snapshot;
    } catch (error) {
      this.metrics.recoveryErrors++;
      logger.error(
        "[OrderBookSnapshotEngine] Failed to recover from latest snapshot:",
        error,
      );
      return null;
    }
  }

  /**
   * Purge snapshots that exceed the retention window. Runs both on an interval
   * and opportunistically after each capture.
   */
  async purgeExpiredSnapshots(): Promise<number> {
    try {
      const redis = getRedisClient();
      if (!redis?.isOpen) return 0;

      const cutoff =
        Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000;
      const keysToDelete: string[] = [];

      for await (const keys of redis.scanIterator({
        MATCH: `${this.config.keyPrefix}:*`,
      })) {
        for (const key of keys) {
          if (key === `${this.config.keyPrefix}:latest`) continue;

          const raw = await redis.get(key);
          if (!raw) {
            keysToDelete.push(key);
            continue;
          }

          try {
            const snapshot = JSON.parse(raw) as OrderBookSnapshot;
            const capturedAt = Date.parse(snapshot.capturedAt);
            if (!Number.isNaN(capturedAt) && capturedAt < cutoff) {
              keysToDelete.push(key);
            }
          } catch {
            keysToDelete.push(key);
          }
        }
      }

      if (keysToDelete.length > 0) {
        await redis.del(keysToDelete);
      }

      this.metrics.snapshotsPurged += keysToDelete.length;
      this.metrics.lastPurgeAt = new Date();
      if (keysToDelete.length > 0) {
        logger.info(
          `[OrderBookSnapshotEngine] Purged ${keysToDelete.length} expired snapshot(s)`,
        );
      }
      return keysToDelete.length;
    } catch (error) {
      logger.error(
        "[OrderBookSnapshotEngine] Failed to purge expired snapshots:",
        error,
      );
      return 0;
    }
  }

  /** Start the engine: recover state, then schedule periodic purges. */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("[OrderBookSnapshotEngine] Already running");
      return;
    }
    this.isRunning = true;

    await this.recoverFromLatestSnapshot();

    this.purgeTimer = setInterval(() => {
      void this.purgeExpiredSnapshots();
    }, this.config.purgeIntervalMs);

    logger.info(
      `[OrderBookSnapshotEngine] Started (snapshot every ${this.config.snapshotIntervalLedgers} ledgers, ` +
        `${this.config.retentionDays}-day retention)`,
    );
  }

  /** Stop the engine. */
  stop(): void {
    if (this.purgeTimer) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = null;
    }
    this.isRunning = false;
    logger.info("[OrderBookSnapshotEngine] Stopped");
  }

  /** Whether the engine is running. */
  isActive(): boolean {
    return this.isRunning;
  }

  /** Current engine metrics. */
  getMetrics(): SnapshotMetrics {
    return { ...this.metrics };
  }

  private applySnapshot(snapshot: OrderBookSnapshot): void {
    this.bids.clear();
    this.asks.clear();

    for (const level of snapshot.bids ?? []) {
      if (
        Number.isFinite(level.price) &&
        Number.isFinite(level.amount) &&
        level.amount > 0
      ) {
        this.bids.set(level.price, level.amount);
      }
    }
    for (const level of snapshot.asks ?? []) {
      if (
        Number.isFinite(level.price) &&
        Number.isFinite(level.amount) &&
        level.amount > 0
      ) {
        this.asks.set(level.price, level.amount);
      }
    }
  }
}

// Singleton instance
let engineInstance: OrderBookSnapshotEngine | null = null;

export function getOrderBookSnapshotEngine(
  config?: Partial<OrderBookSnapshotEngineConfig>,
): OrderBookSnapshotEngine {
  if (!engineInstance) {
    engineInstance = new OrderBookSnapshotEngine(config);
  }
  return engineInstance;
}

export function resetOrderBookSnapshotEngine(): void {
  if (engineInstance) {
    engineInstance.stop();
    engineInstance = null;
  }
}

export const orderBookSnapshotEngine = getOrderBookSnapshotEngine();
