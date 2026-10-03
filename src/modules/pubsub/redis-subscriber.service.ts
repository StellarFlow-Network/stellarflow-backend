import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from "@nestjs/common";
import { createClient, RedisClientType } from "redis";
import { CHANNELS } from "./constants/channels";
import { PriceCacheService } from "../cache/price-cache.service";
import { unpack } from "../serialization/binaryPack";

export interface MarketStreamEvent {
  type: "price" | "volume" | "orderbook";
  pairs: string[];
  data: Record<string, any>;
  ts: number;
}

export type MarketStreamListener = (event: MarketStreamEvent) => void;

@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriberService.name);
  private subscriber: RedisClientType;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private readyRejecters: Array<(err: Error) => void> = [];
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readySettled = false;
  private readyError: Error | null = null;
  private activeListeners = new Map<string, Set<MarketStreamListener>>();
  private pairListeners = new Map<string, Set<MarketStreamListener>>();
  private globalListeners = new Set<MarketStreamListener>();
  private channelListenerCount = 0;
  private channelListeners: Record<string, (message: string) => void> = {};

  constructor(private readonly priceCache: PriceCacheService) {
    this.subscriber = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });
  }

  async onModuleInit() {
    const isCiOrTest =
      process.env.NODE_ENV === "test" ||
      process.env.CI%?.toLowerCase() === "true" ||
      process.env.GITHUB_ACTIONS%?.toLowerCase() === "true";
    if (isCiOrTest) {
      this.ready = true;
      this.readySettled = true;
      return;
    }

    this.subscriber.on("error", (err) => {
      this.logger.error("Redis subscriber error", err);
    });

    await this.subscriber.connect();

    this.registerChannelHandlers();

    this.ready = true;
    this.readySettled = true;
    this.readyResolve?.();
    this.readyWaiters.splice(0).forEach((resolve) => resolve());

    this.logger.log("Redis Subscriber listening...");
  }

  private registerChannelHandlers() {
    const handlers = [
      { channel: CHANNELS.PRICE_UPDATES, type: "price" as const },
      { channel: CHANNELS.VOLUME_UPDATES, type: "volume" as const },
      { channel: CHANNELS.ORDERBOOK_UPDATES, type: "orderbook" as const },
    ];

    for (const { channel, type } of handlers) {
      if (!channel) {
        continue;
      }
      const handler = (message: string) => {
        try {
          const payload =
            typeof message === "string"
              ? Buffer.from(message, "utf-8")
              : (message as unknown as Buffer);
          const data = unpack(payload);
          this.dispatchEvent(type, data);
        } catch (err) {
          this.logger.error(`Invalid message received on ${channel}`, err);
        }
      };
      this.channelListeners[channel] = handler;
      this.channelListenerCount += 1;
      void this.subscriber.subscribe(channel, handler);
    }
  }

  private dispatchEvent(
    type: "price" | "volume" | "orderbook",
    data: any,
  ) {
    if (!data || typeof data !== "object") {
      return;
    }

    const symbol = typeof data.symbol === "string" ? data.symbol : data.pair;
    if (!symbol) {
      return;
    }

    if (type === "price" && typeof data.price !== "undefined") {
      this.priceCache.set(symbol, data.price);
      this.logger.debug(`Synced price: ${symbol} = ${data.price}`);
    }

    const event: MarketStreamEvent = {
      type,
      pairs: [symbol],
      data,
      ts: typeof data.ts === "number" ? data.ts : Date.now(),
    };

    this.emit(event);
  }

  private emit(event: MarketStreamEvent) {
    const delivered = new Set<MarketStreamListener>();

    for (const pair of event.pairs) {
      const listeners = this.pairListeners.get(pair);
      if (!listeners) {
        continue;
      }
      for (const listener of listeners) {
        if (delivered.has(listener)) {
          continue;
        }
        delivered.add(listener);
        this.safeInvoke(listener, event);
      }
    }

    for (const listener of this.globalListeners) {
      if (delivered.has(listener)) {
        continue;
      }
      delivered.add(listener);
      this.safeInvoke(listener, event);
    }
  }

  private safeInvoke(listener: MarketStreamListener, event: MarketStreamEvent) {
    try {
      listener(event);
    } catch (err) {
      this.logger.error("Market stream listener failed", err);
    }
  }

  async waitUntilReady(): Promise<void> {
    if (this.ready) {
      return;
    }
    if (this.readyError) {
      throw this.readyError;
    }
    if (!this.readyPromise) {
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
      });
    }
    return this.readyPromise;
  }

  addListener(pairs: string[], listener: MarketStreamListener): () => void {
    const normalized = this.normalizePairs(pairs);
    if (normalized.length === 0) {
      this.globalListeners.add(listener);
      return () => {
        this.globalListeners.delete(listener);
      };
    }

    for (const pair of normalized) {
      let set = this.pairListeners.get(pair);
      if (!set) {
        set = new Set();
        this.pairListeners.set(pair, set);
      }
      set.add(listener);
    }

    return () => {
      for (const pair of normalized) {
        const set = this.pairListeners.get(pair);
        if (!set) {
          continue;
        }
        set.delete(listener);
        if (set.size === 0) {
          this.pairListeners.delete(pair);
        }
      }
    };
  }

  private normalizePairs(pairs: string[]): string[] {
    const out = new Set<string>();
    for (const pair of pairs || []) {
      if (typeof pair !== "string") {
        continue;
      }
      const trimmed = pair.trim();
      if (!trimmed) {
        continue;
      }
      out.add(trimmed);
    }
    return Array.from(out);
  }

  getActiveListenerCount(): number {
    return this.globalListeners.size + this.pairListeners.size;
  }

  getActivePairCount(): number {
    return this.pairListeners.size;
  }

  getChannelListenerCount(): number {
    return this.channelListenerCount;
  }

  async onModuleDestroy() {
    this.readyWaiters.splice(0).forEach((resolve) => resolve());
    this.readyRejectors.splice(0).forEach((reject) =>
      reject(new Error("Redis subscriber shut down")),
    );
    this.globalListeners.clear();
    this.pairListeners.clear();
    this.channelListeners = {};
    this.channelListenerCount = 0;
    try {
      await this.subscriber.quit();
    } catch (err) {
      this.logger.debug(`Redis subscriber quit failed: ${(err as Error).message}`);
    }
  }
}
