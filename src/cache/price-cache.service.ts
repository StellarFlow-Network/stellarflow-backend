import { Injectable } from '@nestjs/common';

@Injectable()
export class PriceCacheService {
  private cache = new Map<string, number>();

  set(symbol: string, price: number) {
    this.cache.set(symbol, price);
  }

  get(symbol: string): number | undefined {
    return this.cache.get(symbol);
  }

  getAll() {
    return Object.fromEntries(this.cache);
  }
}