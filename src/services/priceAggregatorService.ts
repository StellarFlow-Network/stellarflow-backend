/**
 * PriceAggregatorService – Issue #208
 *
 * A cron-scheduled worker that aggregates raw price-feed ticks (PriceHistory)
 * into OHLC (Open, High, Low, Close) candles for three granularities:
 *   - MINUTE  (1-minute candles, aggregated every minute)
 *   - HOUR    (1-hour candles,   aggregated every 5 minutes)
 *   - DAY     (1-day candles,    aggregated every 15 minutes)
 *
 * Each run performs a "gap-fill" strategy:
 *   1. Determine the look-back window relevant for the granularity.
 *   2. For every (currency, window) pair, upsert the candle using the
 *      actual min/max/first/last values from PriceHistory.
 *
 * Idempotency: Uses Prisma's upsert on the unique constraint
 * (currency, granularity, openTime) so replaying a run is always safe.
 */

import prisma from "../lib/prisma.js";

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

export type Granularity = "MINUTE" | "HOUR" | "DAY";

interface CandleInterval {
  granularity: Granularity;
  /** Length of one candle window in milliseconds */
  windowMs: number;
  /** How many candles back to (re)calculate on each tick */
  lookbackCount: number;
  /** How often this granularity's aggregation runs (ms) */
  cronIntervalMs: number;
}

const INTERVALS: CandleInterval[] = [
  {
    granularity: "MINUTE",
    windowMs: 60_000, // 1 minute
    lookbackCount: 5, // re-compute last 5 minutes
    cronIntervalMs: 60_000, // run every 1 minute
  },
  {
    granularity: "HOUR",
    windowMs: 60 * 60_000, // 1 hour
    lookbackCount: 3, // re-compute last 3 hours
    cronIntervalMs: 5 * 60_000, // run every 5 minutes
  },
  {
    granularity: "DAY",
    windowMs: 24 * 60 * 60_000, // 1 day
    lookbackCount: 3, // re-compute last 3 days
    cronIntervalMs: 15 * 60_000, // run every 15 minutes
  },
];

// ---------------------------------------------------------------------------
// Helper: floor a timestamp to the start of a candle window
// ---------------------------------------------------------------------------

function floorToWindow(date: Date, windowMs: number): Date {
  const ms = Math.floor(date.getTime() / windowMs) * windowMs;
  return new Date(ms);
}

// ---------------------------------------------------------------------------
// PriceAggregatorService
// ---------------------------------------------------------------------------

export class PriceAggregatorService {
  private timers: Map<Granularity, ReturnType<typeof setInterval>> = new Map();
  private isRunning = false;

  // Allow overriding intervals for testing
  constructor(private readonly intervals: CandleInterval[] = INTERVALS) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the aggregator. Fires all granularities immediately, then schedules
   * them on their respective cron intervals.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("[PriceAggregator] Already running – skipping start()");
      return;
    }

    this.isRunning = true;
    console.info("[PriceAggregator] 🚀 Starting OHLC aggregation worker …");

    for (const interval of this.intervals) {
      // Fire immediately so we have data from the first second
      await this.aggregateGranularity(interval).catch((err) => {
        console.error(
          `[PriceAggregator] Initial run failed for ${interval.granularity}:`,
          err,
        );
      });

      // Schedule subsequent runs
      const timer = setInterval(() => {
        this.aggregateGranularity(interval).catch((err) => {
          console.error(
            `[PriceAggregator] Scheduled run failed for ${interval.granularity}:`,
            err,
          );
        });
      }, interval.cronIntervalMs);

      this.timers.set(interval.granularity, timer);

      console.info(
        `[PriceAggregator] ✅ ${interval.granularity} candles scheduled every ${interval.cronIntervalMs / 1000}s`,
      );
    }
  }

  /** Stop all scheduled timers. */
  stop(): void {
    for (const [gran, timer] of this.timers) {
      clearInterval(timer);
      console.info(`[PriceAggregator] Stopped ${gran} scheduler`);
    }
    this.timers.clear();
    this.isRunning = false;
    console.info("[PriceAggregator] 🛑 Aggregation worker stopped");
  }

  /** Restart with a new cron interval for a specific granularity. */
  restartGranularity(granularity: Granularity, cronIntervalMs: number): void {
    const existing = this.timers.get(granularity);
    if (existing) clearInterval(existing);

    const cfg = this.intervals.find((i) => i.granularity === granularity);
    if (!cfg) return;

    const updated: CandleInterval = { ...cfg, cronIntervalMs };
    const timer = setInterval(() => {
      this.aggregateGranularity(updated).catch((err) => {
        console.error(
          `[PriceAggregator] Rescheduled run failed for ${granularity}:`,
          err,
        );
      });
    }, cronIntervalMs);

    this.timers.set(granularity, timer);
    console.info(
      `[PriceAggregator] ${granularity} rescheduled to every ${cronIntervalMs / 1000}s`,
    );
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      scheduledGranularities: [...this.timers.keys()],
    };
  }

  // -------------------------------------------------------------------------
  // Core aggregation logic
  // -------------------------------------------------------------------------

  /**
   * For a given granularity, walk back `lookbackCount` candle windows and
   * upsert each candle from PriceHistory data.
   */
  async aggregateGranularity(interval: CandleInterval): Promise<void> {
    const now = new Date();
    const { granularity, windowMs, lookbackCount } = interval;

    // Determine the start of the current (incomplete) candle window
    const currentWindowStart = floorToWindow(now, windowMs);

    // Fetch all active currencies once per run
    const currencies = await prisma.currency.findMany({
      where: { isActive: true },
      select: { code: true },
    });

    if (currencies.length === 0) return;

    let upsertCount = 0;
    let skipCount = 0;

    // Walk back through candles: include the current incomplete window so
    // it gets refreshed in real-time, plus the N previous completed windows.
    for (let i = 0; i <= lookbackCount; i++) {
      const openTime = new Date(currentWindowStart.getTime() - i * windowMs);
      const closeTime = new Date(openTime.getTime() + windowMs);

      for (const { code: currency } of currencies) {
        const candle = await this.computeCandle(currency, openTime, closeTime);

        if (!candle) {
          skipCount++;
          continue; // No price data in this window – skip
        }

        await prisma.ohlcCandle.upsert({
          where: {
            currency_granularity_openTime: {
              currency,
              granularity,
              openTime,
            },
          },
          create: {
            currency,
            granularity,
            openTime,
            closeTime,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            count: candle.count,
          },
          update: {
            // Re-compute – the candle may still be open (i === 0)
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            count: candle.count,
          },
        });

        upsertCount++;
      }
    }

    console.debug(
      `[PriceAggregator] ${granularity}: upserted=${upsertCount} skipped=${skipCount}`,
    );
  }

  /**
   * Query PriceHistory for a single candle window and compute OHLC values.
   * Returns null when no ticks exist in the window.
   */
  private async computeCandle(
    currency: string,
    openTime: Date,
    closeTime: Date,
  ): Promise<{
    open: number;
    high: number;
    low: number;
    close: number;
    count: number;
  } | null> {
    // Fetch all ticks in the window, ordered chronologically
    const ticks = await prisma.priceHistory.findMany({
      where: {
        currency,
        timestamp: {
          gte: openTime,
          lt: closeTime,
        },
      },
      select: {
        rate: true,
        timestamp: true,
      },
      orderBy: { timestamp: "asc" },
    });

    if (ticks.length === 0) return null;

    const rates = ticks.map((t) => Number(t.rate));

    return {
      open: rates[0],
      high: Math.max(...rates),
      low: Math.min(...rates),
      close: rates[rates.length - 1],
      count: rates.length,
    };
  }
}

// Singleton instance exported for use in index.ts
export const priceAggregatorService = new PriceAggregatorService();
