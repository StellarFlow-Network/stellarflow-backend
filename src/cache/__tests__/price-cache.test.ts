import { describe, it, expect, beforeEach } from "jest";
import { PriceCacheService } from "../price-cache.service";

describe("PriceCacheService High-Frequency Trading In-Memory Cache", () => {
  let priceCache: PriceCacheService;

  beforeEach(() => {
    priceCache = new PriceCacheService();
  });

  it("serves price lookup queries in sub-millisecond latency (<1ms)", () => {
    priceCache.set("XLM/USD", 0.1234);
    priceCache.set("BTC/USD", 65432.10);

    const start = process.hrtime.bigint();
    const xlmPrice = priceCache.get("XLM/USD");
    const btcPrice = priceCache.get("BTC/USD");
    const end = process.hrtime.bigint();

    const durationMs = Number(end - start) / 1_000_000;

    expect(xlmPrice).toBe(0.1234);
    expect(btcPrice).toBe(65432.10);
    expect(durationMs).toBeLessThan(1.0);
  });

  it("invalidates cache entries promptly (<100ms requirement)", async () => {
    priceCache.set("ETH/USD", 3456.78);
    expect(priceCache.get("ETH/USD")).toBe(3456.78);

    const start = Date.now();
    await priceCache.invalidate("ETH/USD");
    const elapsed = Date.now() - start;

    expect(priceCache.get("ETH/USD")).toBeUndefined();
    expect(elapsed).toBeLessThan(100);
  });
});
