import { Router, Request, Response } from "express";
import prisma from "../lib/prisma";

const router = Router();

/**
 * GET /api/stats/relayers
 * 
 * Returns statistics for all relayers (oracle servers) including:
 * - Uptime percentage
 * - Average latency (time from request to signature)
 * - Number of successful pushes (submitted prices)
 */
router.get("/relayers", async (req: Request, res: Response) => {
  try {
    // Get all unique signers/relayers
    const signers = await prisma.multiSigSignature.groupBy({
      by: ["signerPublicKey", "signerName"],
      _count: {
        id: true,
      },
    });

    // Get all submitted multi-sig prices
    const submittedPrices = await prisma.multiSigPrice.findMany({
      where: {
        status: "APPROVED",
        submittedAt: { not: null },
      },
      include: {
        multiSigSignatures: {
          select: {
            signerPublicKey: true,
            signedAt: true,
          },
        },
      },
    });

    // Calculate statistics for each relayer
    const relayerStats = await Promise.all(
      signers.map(async (signer: { signerPublicKey: string; signerName: string; _count: { id: number } }) => {
        const { signerPublicKey, signerName, _count } = signer;

        // Get all signatures by this relayer
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

        // Calculate successful pushes (prices that were submitted to Stellar)
        const successfulPushes = signatures.filter(
          (sig: any) => sig.multiSigPrice.submittedAt !== null
        ).length;

        // Calculate total requests (number of multi-sig prices this relayer was asked to sign)
        const totalRequests = signatures.length;

        // Calculate uptime % (successful signatures / total requests * 100)
        const uptimePercentage =
          totalRequests > 0 ? (successfulPushes / totalRequests) * 100 : 0;

        // Calculate average latency (time from price request to signature)
        const latencies = signatures
          .filter((sig: any) => sig.multiSigPrice.requestedAt && sig.signedAt)
          .map((sig: any) => {
            const requestedAt = new Date(sig.multiSigPrice.requestedAt).getTime();
            const signedAt = new Date(sig.signedAt).getTime();
            return signedAt - requestedAt; // milliseconds
          });

        const averageLatencyMs =
          latencies.length > 0
            ? latencies.reduce((sum: number, latency: number) => sum + latency, 0) /
              latencies.length
            : 0;

        // Get last activity
        const lastActivity = signatures[0]?.signedAt || null;

        // Get failed signatures (signed but price not submitted)
        const failedSignatures = signatures.filter(
          (sig: any) => sig.multiSigPrice.submittedAt === null
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
      })
    );

    // Sort by uptime percentage (descending)
    relayerStats.sort((a: { uptimePercentage: number }, b: { uptimePercentage: number }) => b.uptimePercentage - a.uptimePercentage);

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
      error: error instanceof Error ? error.message : "Failed to fetch relayer statistics",
import { Router } from "express";
import prisma from "../lib/prisma";
import { cacheMiddleware } from "../cache/CacheMiddleware";
import { CACHE_CONFIG, CACHE_KEYS } from "../config/redis.config";

const router = Router();

// GET /api/v1/stats/volume?date=2024-01-15
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
  async (req, res) => {
  try {
    const dateParam = req.query.date as string;

    // Default to today if no date provided
    const targetDate = dateParam ? new Date(dateParam) : new Date();

    // Validate date
    if (isNaN(targetDate.getTime())) {
      res.status(400).json({
        success: false,
        error: "Invalid date format. Use YYYY-MM-DD format.",
      });
      return;
    }

    // Set start and end of day (UTC)
    const startOfDay = new Date(targetDate);
    startOfDay.setUTCHours(0, 0, 0, 0);

    const endOfDay = new Date(targetDate);
    endOfDay.setUTCHours(23, 59, 59, 999);

    // Get price history entries for the day
    const priceHistoryCount = await prisma.priceHistory.count({
      where: {
        timestamp: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });

    // Get on-chain price entries for the day
    const onChainPriceCount = await prisma.onChainPrice.count({
      where: {
        confirmedAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });

    // Get provider requests for the day (from reputation service)
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

    // Calculate total requests (this is cumulative, not daily)
    const totalApiRequests = providerStats.reduce(
      (sum: number, provider: any) => sum + provider.totalRequests,
      0,
    );
    const totalSuccessfulRequests = providerStats.reduce(
      (sum: number, provider: any) => sum + provider.successfulRequests,
      0,
    );
    const totalFailedRequests = providerStats.reduce(
      (sum: number, provider: any) => sum + provider.failedRequests,
      0,
    );

    // Get unique currencies that had activity
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

    // Get unique data sources for the day
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
            ? ((totalSuccessfulRequests / totalApiRequests) * 100).toFixed(2) +
              "%"
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
});

export default router;
