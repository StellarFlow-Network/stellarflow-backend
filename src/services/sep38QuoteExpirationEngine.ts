import { getRedisClient } from "../lib/redis";
import { PrismaClient } from "@prisma/client";

export interface Sep38QuoteRecord {
  id: string;
  quoteId: string;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: string;
  rate: string;
  expiresAt: Date;
  status: "PENDING" | "EXPIRED" | "COMPLETED";
  lockedBuyerId?: string | null;
}

export type QuoteStatus = "PENDING" | "EXPIRED" | "COMPLETED";

export interface ExpirationResult {
  scannedKeys: number;
  expiredQuoteIds: string[];
  purgedCommitments: number;
  transitionedCount: number;
  durationMs: number;
}

export interface RefreshQuoteRequest {
  quoteId: string;
  sourceCurrency?: string;
  targetCurrency?: string;
  sourceAmount?: number;
  routeLiquidityScore?: number;
}

export interface RefreshQuoteResult {
  quoteId: string;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: string;
  rate: string;
  expiresAt: string;
  status: QuoteStatus;
  refreshedFrom?: string;
}

const QUOTE_KEY_PREFIX = "quote:sep38:";
const QUOTE_LOCK_PREFIX = "quote:sep38:lock:";
const DEFAULT_QUOTE_TTL_SECONDS = 60;
const SCAN_BATCH_SIZE = 250;

export class Sep38QuoteExpirationEngine {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? new PrismaClient();
  }

  /**
   * Scan the Redis keyspace for SEP-38 quote keys that have expired,
   * transition the corresponding PostgreSQL records to EXPIRED, and
   * purge locked quote commitments.
   */
  async runExpirationSweep(): Promise<ExpirationResult> {
    const startedAt = Date.now();
    const redis = getRedisClient();

    if (!redis || !redis.isOpen) {
      return {
        scannedKeys: 0,
        expiredQuoteIds: [],
        purgedCommitments: 0,
        transitionedCount: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const expiredQuoteIds = new Set<string>();
    const purgedCommitmentKeys = new Set<string>();
    let scannedKeys = 0;
    let cursor = "0";

    do {
      const reply = await redis.scan(cursor, {
        MATCH: `${QUOTE_KEY_PREFIX}*`,
        COUNT: SCAN_BATCH_SIZE,
      });
      cursor = reply.cursor;
      const keys = reply.keys;
      scannedKeys += keys.length;

      for (const key of keys) {
        if (key.startsWith(QUOTE_LOCK_PREFIX)) {
          continue;
        }

        const ttl = await redis.pTTL(key);
        // -2, -1 means key is already gone or has no TTL. We only treat
        // keys with a positive TTL as live; expired ones are handled below.
        if (ttl > 0) {
          continue;
        }

        const quoteId = key.slice(QUOTE_KEY_PREFIX.length);
        if (!quoteId) {
          continue;
        }

        expiredQuoteIds.add(quoteId);
        const lockKey = `${QUOTE_LOCK_PREFIX}${quoteId}`;
        const lockExists = await redis.exists(lockKey);
        if (lockExists) {
          purgedCommitmentKeys.add(lockKey);
        }
      }
    } while (cursor !== "0");

    // Purge locked commitments in a single round-trip.
    if (purgedCommitmentKeys.size > 0) {
      await redis.del(Array.from(purgedCommitmentKeys));
    }

    // Also catch quotes that have expired by wall-clock even if the Redis
    // key was already removed (e.g. evicted).
    const now = new Date();
    const wallClockExpired = await this.prisma.sep38Quote.findMany({
      where: {
        status: "PENDING",
        expiresAt: { lte: now },
      },
      select: {
        quoteId: true,
      },
      take: 1000,
    });

    for (const record of wallClockExpired) {
      expiredQuoteIds.add(record.quoteId);
    }

    let transitionedCount = 0;
    if (expiredQuoteIds.size > 0) {
      const ids = Array.from(expiredQuoteIds);
      const result = await this.prisma.sep38Quote.updateMany({
        where: {
          quoteId: { in: ids },
          status: "PENDING",
        },
        data: { status: "EXPIRED" },
      });
      transitionedCount = result.count;
    }

    return {
      scannedKeys,
      expiredQuoteIds: Array.from(expiredQuoteIds),
      purgedCommitments: purgedCommitmentKeys.size,
      transitionedCount,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Refresh an existing SEP-38 quote by re-issuing a new one against live
   * anchor rates. The old quote is transitioned to EXPIRED and its Redis
   * commitment is purged.
   */
  async refreshQuote(req: RefreshQuoteRequest): Promise<RefreshQuoteResult> {
    const existing = await this.prisma.sep38Quote.findUnique({
      where: { quoteId: req.quoteId },
    });

    if (!existing) {
      throw new Error(`SEP-38 quote ${req.quoteId} not found`);
    }

    const sourceCurrency = (req.sourceCurrency ?? existing.sourceCurrency).toUpperCase();
    const targetCurrency = (req.targetCurrency ?? existing.targetCurrency).toUpperCase();
    const sourceAmount = req.sourceAmount ?? Number(existing.sourceAmount);

    if (!Number.isFinite(sourceAmount) || sourceAmount <= 0) {
      throw new Error("sourceAmount must be a valid positive number");
    }

    // Resolve live anchor rate. We prefer an explicit liquidity score,
    // otherwise fall back to the previous quote rate as a sanity base.
    const liveRate = await this.resolveLiveRate(
      sourceCurrency,
      targetCurrency,
      req.routeLiquidityScore,
    );

    const expiresAt = new Date(Date.now() + DEFAULT_QUOTE_TTL_SECONDS * 1000);
    const newQuoteId = `${req.quoteId}-r${Date.now().toString(36)}`;

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.sep38Quote.updateMany({
        where: { quoteId: req.quoteId, status: "PENDING" },
        data: { status: "EXPIRED" },
      });

      return tx.sep38Quote.create({
        data: {
          quoteId: newQuoteId,
          sourceCurrency,
          targetCurrency,
          sourceAmount: sourceAmount.toString(),
          rate: liveRate.toString(),
          expiresAt,
          status: "PENDING",
        },
      });
    });

    const redis = getRedisClient();
    if (redis && redis.isOpen) {
      const ttlSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
      const payload = JSON.stringify({
        quoteId: newQuoteId,
        sourceCurrency,
        targetCurrency,
        sourceAmount: sourceAmount.toString(),
        rate: liveRate.toString(),
        expiresAt: expiresAt.toISOString(),
      });
      await redis.set(`${QUOTE_KEY_PREFIX}${newQuoteId}`, payload, {
        EX: ttlSeconds,
      });
      await redis.del(`${QUOTE_LOCK_PREFIX}${req.quoteId}`);
    }

    return {
      quoteId: created.quoteId,
      sourceCurrency,
      targetCurrency,
      sourceAmount: created.sourceAmount,
      rate: created.rate,
      expiresAt: created.expiresAt.toISOString(),
      status: created.status as QuoteStatus,
      refreshedFrom: req.quoteId,
    };
  }

  private async resolveLiveRate(
    sourceCurrency: string,
    targetCurrency: string,
    liquidityScore?: number,
  ): Promise<number> {
    // Live anchor rates are sourced from the market rates table. We apply a
    // liquidity adjustment on top of the mid rate to reflect the route's
    // current depth.
    const marketRate = await this.prisma.marketRate.findFirst({
      where: {
        sourceCurrency,
        targetCurrency,
      },
      orderBy: { updatedAt: "desc" },
    });

    if (!marketRate) {
      throw new Error(
        `No live anchor rate available for ${sourceCurrency} -> ${targetCurrency}`,
      );
    }

    const baseRate = Number(marketRate.rate);
    if (!Number.isFinite(baseRate) || baseRate <= 0) {
      throw new Error(`Invalid live anchor rate for ${sourceCurrency} -> ${targetCurrency}`);
    }

    const score = liquidityScore ?? 1;
    const adjusted = baseRate * (1 - 0.01 * (1 - score));
    return Number(adjusted.toFixed(8));
  }
}
