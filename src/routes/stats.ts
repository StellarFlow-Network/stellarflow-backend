import { Router } from "express";
import prisma from "../lib/prisma";

const router = Router();

// GET /api/v1/stats/volume?date=2024-01-15
router.get("/volume", async (req, res) => {
  try {
    const dateParam = req.query.date as string;
    
    // Default to today if no date provided
    const targetDate = dateParam 
      ? new Date(dateParam) 
      : new Date();
    
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
    const totalApiRequests = providerStats.reduce((sum: number, provider: any) => sum + provider.totalRequests, 0);
    const totalSuccessfulRequests = providerStats.reduce((sum: number, provider: any) => sum + provider.successfulRequests, 0);
    const totalFailedRequests = providerStats.reduce((sum: number, provider: any) => sum + provider.failedRequests, 0);
    
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
      distinct: ['currency'],
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
      distinct: ['source'],
    });
    
    const volumeStats = {
      date: targetDate.toISOString().split('T')[0],
      dataPoints: {
        priceHistoryEntries: priceHistoryCount,
        onChainConfirmations: onChainPriceCount,
        total: priceHistoryCount + onChainPriceCount,
      },
      apiRequests: {
        total: totalApiRequests,
        successful: totalSuccessfulRequests,
        failed: totalFailedRequests,
        successRate: totalApiRequests > 0 ? (totalSuccessfulRequests / totalApiRequests * 100).toFixed(2) + '%' : '0%',
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
        successRate: provider.totalRequests > 0 
          ? (provider.successfulRequests / provider.totalRequests * 100).toFixed(2) + '%'
          : '0%',
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
