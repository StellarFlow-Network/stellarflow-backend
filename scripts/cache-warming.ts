import { cacheService } from "../src/cache/CacheService";
import { CACHE_CONFIG, CACHE_KEYS } from "../src/config/redis.config";
import prisma from "../src/lib/prisma";

/**
 * Cache warming script to pre-populate frequently accessed data
 * Run on server startup or manually: tsx scripts/cache-warming.ts
 */

async function warmCache() {
  console.log("[Cache Warming] Starting cache warming...");

  try {
    // Warm up active currencies
    const currencies = await prisma.currency.findMany({
      where: { isActive: true },
      select: { code: true, name: true, symbol: true },
      orderBy: { code: "asc" },
    });

    await cacheService.set(
      CACHE_KEYS.assets.all(),
      { success: true, assets: currencies },
      CACHE_CONFIG.ttl.assets,
    );
    console.log(`[Cache Warming] Cached ${currencies.length} currencies`);

    // Warm up recent price history for each currency
    for (const currency of currencies) {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days

      const history = await prisma.priceHistory.findMany({
        where: {
          currency: currency.code,
          timestamp: { gte: since },
        },
        orderBy: { timestamp: "asc" },
        select: { timestamp: true, rate: true, source: true },
      });

      if (history.length > 0) {
        await cacheService.set(
          CACHE_KEYS.history.asset(currency.code, "7d"),
          {
            success: true,
            asset: currency.code,
            range: "7d",
            data: history.map((r) => ({
              timestamp: r.timestamp.toISOString(),
              rate: Number(r.rate),
              source: r.source,
            })),
          },
          CACHE_CONFIG.ttl.history,
        );
        console.log(
          `[Cache Warming] Cached 7d history for ${currency.code} (${history.length} entries)`,
        );
      }
    }

    // Warm up today's volume stats
    const today = new Date();
    const startOfDay = new Date(today);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const priceHistoryCount = await prisma.priceHistory.count({
      where: {
        timestamp: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });

    const onChainPriceCount = await prisma.onChainPrice.count({
      where: {
        confirmedAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });

    const dateStr = today.toISOString().split("T")[0];
    await cacheService.set(
      CACHE_KEYS.stats.volume(dateStr),
      {
        success: true,
        data: {
          date: dateStr,
          dataPoints: {
            priceHistoryEntries: priceHistoryCount,
            onChainConfirmations: onChainPriceCount,
            total: priceHistoryCount + onChainPriceCount,
          },
        },
      },
      CACHE_CONFIG.ttl.stats,
    );
    console.log(`[Cache Warming] Cached volume stats for ${dateStr}`);

    console.log("[Cache Warming] Cache warming completed successfully");
  } catch (error) {
    console.error("[Cache Warming] Error during cache warming:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  warmCache()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { warmCache };
