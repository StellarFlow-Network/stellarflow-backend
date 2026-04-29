import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";
import { cacheMiddleware } from "../cache/CacheMiddleware";
import { CACHE_CONFIG, CACHE_KEYS } from "../config/redis.config";

const router = Router();

/**
 * GET /api/v1/stats/relayers
 * Returns statistics for all relayers including uptime, latency, and push counts.
 */
router.get("/relayers", async (req: Request, res: Response) => {
  try {
    const signers = await prisma.multiSigSignature.groupBy({
      by: ["signerPublicKey", "signerName"],
      _count: {
        id: true,
      },
    });

    const relayerStats = await Promise.all(
      signers.map(async (signer) => {
        const { signerPublicKey, signerName, _count } = signer;

        const signatures = await prisma.multiSigSignature.findMany({
          where: { signerPublicKey },
          include: {
            multiSigPrice: {
              select: {
                requestedAt: true,
                submittedAt: true,
                status: true,
              },
            },
          },
          orderBy: {
            signedAt: "desc",
          },
        });

        const successfulPushes = signatures.filter(
          (sig: any) => sig.multiSigPrice.submittedAt !== null,
        ).length;

        const totalRequests = signatures.length;
        const uptimePercentage =
          totalRequests > 0 ? (successfulPushes / totalRequests) * 100 : 0;

        const latencies = signatures
          .filter((sig: any) => sig.multiSigPrice.requestedAt && sig.signedAt)
          .map((sig: any) => {
            const requestedAt = new Date(
              sig.multiSigPrice.requestedAt,
            ).getTime();
            const signedAt = new Date(sig.signedAt).getTime();
            return signedAt - requestedAt;
          });

        const averageLatencyMs =
          latencies.length > 0
            ? latencies.reduce(
                (sum: number, latency: number) => sum + latency,
                0,
              ) / latencies.length
            : 0;

        const lastActivity = signatures[0]?.signedAt || null;
        const failedSignatures = signatures.filter(
          (sig: any) => sig.multiSigPrice.submittedAt === null,
        ).length;

        return {
          signerPublicKey,
          signerName,
          totalSignatures: _count.id,
          successfulPushes,
          failedSignatures,
          uptimePercentage: Math.round(uptimePercentage * 100) / 100,
          averageLatencyMs: Math.round(averageLatencyMs * 100) / 100,
          lastActivity,
        };
      }),
    );

    relayerStats.sort((a, b) => b.uptimePercentage - a.uptimePercentage);

    res.json({
      success: true,
      data: {
        totalRelayers: relayerStats.length,
        relayers: relayerStats,
      },
    });
  } catch (error) {
    console.error("[API] Relayer stats fetch failed:", error);
    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to fetch relayer statistics",
    });
  }
});

/**
 * GET /api/v1/stats/volume?date=YYYY-MM-DD
 * Returns daily volume and request statistics.
 */
router.get(
  "/volume",
  cacheMiddleware({
    ttl: CACHE_CONFIG.ttl.stats,
    keyGenerator: (req) => {
      const dateParam = req.query.date as string;
      const targetDate = dateParam ? new Date(dateParam) : new Date();
      const dateStr = targetDate.toISOString().split("T")[0];
      return CACHE_KEYS.stats.volume(dateStr);
    },
  }),
  async (req: Request, res: Response) => {
    try {
      const dateParam = req.query.date as string;
      const targetDate = dateParam ? new Date(dateParam) : new Date();

      if (isNaN(targetDate.getTime())) {
        res.status(400).json({
          success: false,
          error: "Invalid date format. Use YYYY-MM-DD format.",
        });
        return;
      }

      const startOfDay = new Date(targetDate);
      startOfDay.setUTCHours(0, 0, 0, 0);
      const endOfDay = new Date(targetDate);
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

      const providerStats = await prisma.providerReputation.findMany({
        select: {
          providerName: true,
          totalRequests: true,
          successfulRequests: true,
          failedRequests: true,
          lastSuccess: true,
          lastFailure: true,
        },
      });

      const totalApiRequests = providerStats.reduce(
        (sum, provider) => sum + provider.totalRequests,
        0,
      );
      const totalSuccessfulRequests = providerStats.reduce(
        (sum, provider) => sum + provider.successfulRequests,
        0,
      );
      const totalFailedRequests = providerStats.reduce(
        (sum, provider) => sum + provider.failedRequests,
        0,
      );

      const activeCurrencies = await prisma.priceHistory.findMany({
        where: {
          timestamp: {
            gte: startOfDay,
            lte: endOfDay,
          },
        },
        select: {
          currency: true,
        },
        distinct: ["currency"],
      });

      const activeSources = await prisma.priceHistory.findMany({
        where: {
          timestamp: {
            gte: startOfDay,
            lte: endOfDay,
          },
        },
        select: {
          source: true,
        },
        distinct: ["source"],
      });

      const volumeStats = {
        date: targetDate.toISOString().split("T")[0],
        dataPoints: {
          priceHistoryEntries: priceHistoryCount,
          onChainConfirmations: onChainPriceCount,
          total: priceHistoryCount + onChainPriceCount,
        },
        apiRequests: {
          total: totalApiRequests,
          successful: totalSuccessfulRequests,
          failed: totalFailedRequests,
          successRate:
            totalApiRequests > 0
              ? ((totalSuccessfulRequests / totalApiRequests) * 100).toFixed(
                  2,
                ) + "%"
              : "0%",
        },
        activity: {
          activeCurrencies: activeCurrencies.length,
          activeDataSources: activeSources.length,
          currencies: activeCurrencies.map((c: any) => c.currency),
          sources: activeSources.map((s: any) => s.source),
        },
        providers: providerStats.map((provider: any) => ({
          name: provider.providerName,
          totalRequests: provider.totalRequests,
          successRate:
            provider.totalRequests > 0
              ? (
                  (provider.successfulRequests / provider.totalRequests) *
                  100
                ).toFixed(2) + "%"
              : "0%",
          lastActivity: provider.lastSuccess || provider.lastFailure,
        })),
      };

      res.json({
        success: true,
        data: volumeStats,
      });
    } catch (error) {
      console.error("Error fetching volume stats:", error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Internal server error",
      });
    }
  },
);

export default router;
