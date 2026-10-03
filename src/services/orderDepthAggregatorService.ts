import { RESP_TYPES, type RedisClientType } from "redis";

import { getRedisClient } from "../lib/redis";
import { logger } from "../utils/logger";
import {
  decodeOrderDepth,
  encodeOrderDepth,
  isCompressedOrderDepth,
} from "./orderBookDepthCompression";

export type OrderSide = "bids" | "asks";

export interface DepthLevel {
  price: string;
  volume: string;
  cumulativeVolume: string;
  orderCount: number;
}

export interface OrderDepth {
  market: string;
  tickSize: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
  generatedAt: string;
}

interface RedisOrder {
  price: string | number;
  volume: string | number;
}

/** The subset of the node-redis client used to read binary cache payloads. */
interface BinaryRedisReader {
  get(key: string): Promise<Buffer | null>;
}

const DEFAULT_KEY_PREFIX = "orders:book";

function parsePositiveDecimal(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return parsed;
}

function decimalString(value: number): string {
  return Number(value.toFixed(12)).toString();
}

function parseOrder(member: string): RedisOrder | null {
  try {
    const parsed: unknown = JSON.parse(member);
    if (!parsed || typeof parsed !== "object") return null;
    const order = parsed as Partial<RedisOrder>;
    const price = parsePositiveDecimal(order.price, "price");
    const volume = parsePositiveDecimal(order.volume, "volume");
    return { price, volume };
  } catch {
    return null;
  }
}

/**
 * node-redis decodes RESP blob strings as UTF-8 strings, which would mangle a
 * compressed depth payload. Mapping `RESP_TYPES.BLOB_STRING` to `Buffer` makes
 * `GET` hand back the exact bytes that were written.
 */
function getBinaryRedisReader(redis: RedisClientType): BinaryRedisReader {
  return redis.withTypeMapping({
    [RESP_TYPES.BLOB_STRING]: Buffer,
  }) as unknown as BinaryRedisReader;
}

class OrderDepthAggregatorService {
  async getDepth(
    market: string,
    tickSize: string | number,
  ): Promise<OrderDepth> {
    const normalizedMarket = market.trim();
    if (!normalizedMarket || normalizedMarket.length > 100) {
      throw new Error("market must be a non-empty value up to 100 characters");
    }

    const numericTickSize = parsePositiveDecimal(tickSize, "tickSize");
    const redis = getRedisClient();
    if (!redis?.isReady) {
      throw new Error("Redis depth store is unavailable");
    }

    const keyPrefix = process.env.ORDER_BOOK_REDIS_PREFIX ?? DEFAULT_KEY_PREFIX;
    const [bidMembers, askMembers] = await Promise.all([
      redis.zRange(`${keyPrefix}:${normalizedMarket}:bids`, 0, -1),
      redis.zRange(`${keyPrefix}:${normalizedMarket}:asks`, 0, -1),
    ]);

    return {
      market: normalizedMarket,
      tickSize: decimalString(numericTickSize),
      bids: this.aggregateSide(bidMembers, numericTickSize, "bids"),
      asks: this.aggregateSide(askMembers, numericTickSize, "asks"),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Persist the aggregated depth for a market. The document is stored as a
   * compressed binary payload (see `orderBookDepthCompression`) instead of
   * JSON to cut the Redis footprint of the per-pair depth cache.
   */
  async updateDepth(
    market: string,
    tickSize: string | number,
  ): Promise<void> {
    const depth = await this.getDepth(market, tickSize);
    const redis = getRedisClient();
    if (!redis?.isReady) return;

    await redis.set(this.cacheKey(market), encodeOrderDepth(depth));
  }

  /**
   * Read the cached depth for a market, decompressing payloads written by
   * {@link updateDepth}. Entries persisted before the compressed format shipped
   * (plain JSON strings) are still readable, so a deploy does not drop the live
   * cache; unreadable entries are discarded so the caller can rebuild them.
   */
  async getCachedDepth(market: string): Promise<OrderDepth | null> {
    const redis = getRedisClient();
    if (!redis?.isReady) return null;

    const raw = await getBinaryRedisReader(redis).get(this.cacheKey(market));
    if (!raw || raw.length === 0) return null;

    try {
      if (isCompressedOrderDepth(raw)) {
        return decodeOrderDepth(raw);
      }
      return JSON.parse(raw.toString("utf8")) as OrderDepth;
    } catch (error) {
      logger.warn(
        `[OrderDepthAggregatorService] Discarding unreadable depth cache entry for ${market}:`,
        error,
      );
      return null;
    }
  }

  private cacheKey(market: string): string {
    return `${this.keyPrefix}:${market}:depth:cache`;
  }

  private get keyPrefix(): string {
    return process.env.ORDER_BOOK_REDIS_PREFIX ?? DEFAULT_KEY_PREFIX;
  }

  private aggregateSide(
    members: string[],
    tickSize: number,
    side: OrderSide,
  ): DepthLevel[] {
    const levels = new Map<number, { volume: number; orderCount: number }>();

    for (const member of members) {
      const order = parseOrder(member);
      if (!order) continue;
      const price = Number(order.price);
      const tick = Math.floor((price + Number.EPSILON) / tickSize) * tickSize;
      const current = levels.get(tick) ?? { volume: 0, orderCount: 0 };
      current.volume += Number(order.volume);
      current.orderCount += 1;
      levels.set(tick, current);
    }

    const sortedLevels = [...levels.entries()].sort(([left], [right]) =>
      side === "bids" ? right - left : left - right,
    );
    let cumulativeVolume = 0;
    return sortedLevels.map(([price, level]) => {
      cumulativeVolume += level.volume;
      return {
        price: decimalString(price),
        volume: decimalString(level.volume),
        cumulativeVolume: decimalString(cumulativeVolume),
        orderCount: level.orderCount,
      };
    });
  }
}

export const orderDepthAggregatorService = new OrderDepthAggregatorService();
