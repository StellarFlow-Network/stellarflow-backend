import { getRedisClient } from "../lib/redis";
import { broadcastToSessions } from "../lib/socket";
import { createFetcherLogger } from "../utils/logger";

export type OrderSide = "bid" | "ask";
export type OrderEventType = "created" | "executed" | "cancelled";

export interface OrderBookEvent {
  market: string;
  side: OrderSide;
  orderId: string;
  price: number;
  quantity: number;
  type: OrderEventType;
  timestamp?: number;
}

export interface OrderBookDepthRow {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  market: string;
  bids: OrderBookDepthRow[];
  asks: OrderBookDepthRow[];
  spread: number | null;
  updatedAt: string;
}

interface MarketOrderCache {
  bids: Map<number, number>;
  asks: Map<number, number>;
  [side: string]: Map<number, number>;
}

function normalizeMarket(market: string): string {
  return market.trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeSide(side: string): OrderSide {
  const value = side.toLowerCase();
  if (value === "buy" || value === "bid") return "bid";
  if (value === "sell" || value === "ask") return "ask";
  throw new Error(`Unsupported order side: ${side}`);
}

function toPositiveNumber(value: unknown, label: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return numeric;
}

export class OrderBookSynchronizer {
  private readonly logger = createFetcherLogger("OrderBookSynchronizer");
  private readonly localCache = new Map<string, MarketOrderCache>();
  private readonly maxDepthRows = 25;

  constructor() {
    this.logger.info("Order book synchronizer initialized");
  }

  public async processOrderEvent(event: Partial<OrderBookEvent>): Promise<OrderBookSnapshot> {
    const market = normalizeMarket(String(event.market ?? ""));
    if (!market) {
      throw new Error("Order event requires a market name");
    }

    const side = normalizeSide(String(event.side ?? event.type ?? "bid"));
    const orderId = String(event.orderId ?? `${Date.now()}:${Math.random()}`);
    const price = toPositiveNumber(event.price, "price");
    const quantity = toPositiveNumber(event.quantity, "quantity");
    const type = (event.type ?? "created").toLowerCase() as OrderEventType;

    const normalizedEvent: OrderBookEvent = {
      market,
      side,
      orderId,
      price,
      quantity,
      type,
      timestamp: event.timestamp ?? Date.now(),
    };

    const cache = this.ensureMarketCache(market);

    switch (normalizedEvent.type) {
      case "created": {
        const currentQty = cache[side]!.get(price) ?? 0;
        cache[side]!.set(price, currentQty + normalizedEvent.quantity);
        await this.persistRedisPriceLevel(market, side, price);
        break;
      }
      case "executed": {
        const currentQty = cache[side]!.get(price) ?? 0;
        const nextQty = Math.max(0, currentQty - normalizedEvent.quantity);
        if (nextQty > 0) {
          cache[side]!.set(price, nextQty);
        } else {
          cache[side]!.delete(price);
        }
        await this.persistRedisPriceLevel(market, side, price, nextQty);
        break;
      }
      case "cancelled": {
        cache[side]!.delete(price);
        await this.removeRedisPriceLevel(market, side, price);
        break;
      }
      default:
        throw new Error(`Unsupported order event type: ${normalizedEvent.type}`);
    }

    const snapshot = this.buildSnapshot(market, cache);
    broadcastToSessions("orderbook:depth", snapshot);
    return snapshot;
  }

  public async getDepth(market: string): Promise<OrderBookSnapshot> {
    const normalizedMarket = normalizeMarket(market);
    const cache = await this.hydrateMarketFromRedis(normalizedMarket);
    const snapshot = this.buildSnapshot(normalizedMarket, cache);
    return snapshot;
  }

  public async hydrateMarketFromRedis(market: string): Promise<MarketOrderCache> {
    const normalizedMarket = normalizeMarket(market);
    const cache = this.ensureMarketCache(normalizedMarket);
    const redis = getRedisClient();

    if (!redis) {
      return cache;
    }

    for (const side of ["bid", "ask"] as const) {
      const key = this.getRedisKey(normalizedMarket, side);
      const entries = await redis.zRangeWithScores(key, 0, -1);
      const nextMap = new Map<number, number>();

      for (const entry of entries) {
        const parsedPrice = Number(entry.score);
        if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
          continue;
        }
        nextMap.set(parsedPrice, this.getQuantityFromCache(normalizedMarket, side, parsedPrice));
      }

      cache[side] = nextMap;
    }

    return cache;
  }

  private ensureMarketCache(market: string): MarketOrderCache {
    if (!this.localCache.has(market)) {
      this.localCache.set(market, {
        bids: new Map<number, number>(),
        asks: new Map<number, number>(),
      });
    }
    return this.localCache.get(market)!;
  }

  private getQuantityFromCache(
    market: string,
    side: OrderSide,
    price: number,
  ): number {
    const cache = this.ensureMarketCache(market);
    return cache[side]!.get(price) ?? 0;
  }

  private buildSnapshot(market: string, cache: MarketOrderCache): OrderBookSnapshot {
    const bids = [...cache.bids.entries()]
      .sort((left, right) => right[0] - left[0])
      .slice(0, this.maxDepthRows)
      .map(([price, quantity]) => ({ price, quantity }));

    const asks = [...cache.asks.entries()]
      .sort((left, right) => left[0] - right[0])
      .slice(0, this.maxDepthRows)
      .map(([price, quantity]) => ({ price, quantity }));

    let spread: number | null = null;
    if (bids.length > 0 && asks.length > 0) {
      const bestBid = bids[0]?.price ?? 0;
      const bestAsk = asks[0]?.price ?? 0;
      if (bestAsk > 0 && bestBid > 0) {
        spread = bestAsk - bestBid;
      }
    }

    return {
      market,
      bids,
      asks,
      spread,
      updatedAt: new Date().toISOString(),
    };
  }

  private getRedisKey(market: string, side: OrderSide): string {
    return `orderbook:${market}:${side}`;
  }

  private async persistRedisPriceLevel(
    market: string,
    side: OrderSide,
    price: number,
    quantityOverride?: number,
  ): Promise<void> {
    const redis = getRedisClient();
    if (!redis) {
      return;
    }

    const cache = this.ensureMarketCache(market);
    const nextQty = quantityOverride ?? cache[side]!.get(price) ?? 0;

    if (nextQty <= 0) {
      await redis.zRem(this.getRedisKey(market, side), String(price));
      return;
    }

    await redis.zAdd(this.getRedisKey(market, side), {
      score: price,
      value: String(price),
    });

    cache[side]!.set(price, nextQty);
  }

  private async removeRedisPriceLevel(
    market: string,
    side: OrderSide,
    price: number,
  ): Promise<void> {
    const redis = getRedisClient();
    if (!redis) {
      return;
    }

    const cache = this.ensureMarketCache(market);
    cache[side]!.delete(price);
    await redis.zRem(this.getRedisKey(market, side), String(price));
  }
}

export const orderBookSynchronizer = new OrderBookSynchronizer();
export default orderBookSynchronizer;
