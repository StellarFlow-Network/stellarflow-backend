import { Injectable } from '@nestjs/common';

@Injectable()
export class PriceCacheService {
  private cache = new Map<string, { price: number; updatedAt: number }>();
  private l2PubSubClient: any = null;
  private l2SubClient: any = null;
  private invalidationCallback?: (symbol: string) => void;

  constructor() {
    this.initL2Sync().catch((err) => {
      console.error('[PriceCacheService] Failed to initialize L2 Redis sync:', err);
    });
  }

  private async initL2Sync() {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      const { createClient } = await import('redis');
      this.l2PubSubClient = createClient({ url: redisUrl });
      this.l2SubClient = createClient({ url: redisUrl });
      await this.l2PubSubClient.connect();
      await this.l2SubClient.connect();

      await this.l2SubClient.subscribe('stellarflow:price:invalidation', (message: string) => {
        try {
          const data = JSON.parse(message);
          if (data && data.symbol) {
            const normalized = data.symbol.toUpperCase();
            this.cache.delete(normalized);
            if (this.invalidationCallback) {
              this.invalidationCallback(normalized);
            }
          }
        } catch (e) {
          console.error('[PriceCacheService] Failed to parse invalidation message:', e);
        }
      });
    } catch (err) {
      // Fallback gracefully if Redis is unavailable in local/test environments
    }
  }

  set(symbol: string, price: number) {
    const normalized = symbol.toUpperCase();
    this.cache.set(normalized, { price, updatedAt: Date.now() });
  }

  get(symbol: string): number | undefined {
    const normalized = symbol.toUpperCase();
    const entry = this.cache.get(normalized);
    return entry ? entry.price : undefined;
  }

  async invalidate(symbol: string): Promise<void> {
    const normalized = symbol.toUpperCase();
    this.cache.delete(normalized);
    if (this.l2PubSubClient) {
      try {
        await this.l2PubSubClient.publish(
          'stellarflow:price:invalidation',
          JSON.stringify({ symbol: normalized, timestamp: Date.now() })
        );
      } catch (err) {
        // Non-blocking publish failure
      }
    }
  }

  getAll() {
    const result: Record<string, number> = {};
    for (const [symbol, entry] of this.cache.entries()) {
      result[symbol] = entry.price;
    }
    return result;
  }

  setInvalidationListener(cb: (symbol: string) => void) {
    this.invalidationCallback = cb;
  }
}