import { getRedisClient } from "../lib/redis";

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

  async updateDepth(
    market: string,
    tickSize: string | number,
  ): Promise<void> {
    const depth = await this.getDepth(market, tickSize);
    const redis = getRedisClient();
    if (!redis?.isReady) return;

    const keyPrefix = process.env.ORDER_BOOK_REDIS_PREFIX ?? DEFAULT_KEY_PREFIX;
    await redis.set(`${keyPrefix}:${market}:depth:cache`, JSON.stringify(depth));
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