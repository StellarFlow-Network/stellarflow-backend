import { Router } from "express";
import { getRate, getAllRates } from "../controllers/marketRatesController";
import { MarketRateService } from "../services/marketRate";
import { cacheMiddleware, invalidateCache } from "../cache/CacheMiddleware";
import { CACHE_CONFIG, CACHE_KEYS } from "../config/redis.config";
import { isLockdownError } from "../state/appState";
const marketRateService = new MarketRateService();
const router = Router();
// Get rate for specific currency
router.get("/rate/:currency", cacheMiddleware({
    ttl: CACHE_CONFIG.ttl.marketRates,
    keyGenerator: (req) => CACHE_KEYS.marketRates.single(req.params.currency),
}), getRate);
// Get all available rates
router.get("/rates", cacheMiddleware({
    ttl: CACHE_CONFIG.ttl.marketRates,
    keyGenerator: () => CACHE_KEYS.marketRates.all(),
}), getAllRates);
// GET /api/v1/market-rates/latest
router.get("/latest", cacheMiddleware({
    ttl: CACHE_CONFIG.ttl.marketRates,
    keyGenerator: () => CACHE_KEYS.marketRates.latest(),
}), async (req, res) => {
    try {
        const result = await marketRateService.getLatestPrices();
        if (result.success) {
            res.json({
                success: true,
                data: result.data,
                ...(result.errors && { errors: result.errors }),
            });
        }
        else {
            res.status(500).json({
                success: false,
                error: result.error,
            });
        }
    }
    catch (error) {
        console.error("Error fetching latest prices:", error);
        res.status(500).json({
            success: false,
            error: error instanceof Error
                ? error.message
                : "Failed to fetch latest prices",
        });
    }
});
// Pending reviews
router.get("/reviews/pending", cacheMiddleware({
    ttl: CACHE_CONFIG.ttl.marketRates,
    keyGenerator: () => CACHE_KEYS.marketRates.pendingReviews(),
}), async (req, res) => {
    try {
        const reviews = await marketRateService.getPendingReviews();
        res.json({
            success: true,
            data: reviews,
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error
                ? error.message
                : "Failed to fetch pending price reviews",
        });
    }
});
// Approve review
router.post("/reviews/:id/approve", invalidateCache("market-rates:*"), async (req, res) => {
    try {
        const reviewId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(reviewId)) {
            res.status(400).json({
                success: false,
                error: "Review ID must be a valid number",
            });
            return;
        }
        const { reviewedBy, note } = req.body ?? {};
        const review = await marketRateService.approvePendingReview(reviewId, reviewedBy, note);
        res.json({
            success: true,
            data: review,
        });
    }
    catch (error) {
        res.status(isLockdownError(error) ? error.statusCode : 500).json({
            success: false,
            error: error instanceof Error
                ? error.message
                : "Failed to approve price review",
        });
    }
});
// Reject review
router.post("/reviews/:id/reject", invalidateCache("market-rates:*"), async (req, res) => {
    try {
        const reviewId = Number.parseInt(req.params.id, 10);
        if (!Number.isFinite(reviewId)) {
            res.status(400).json({
                success: false,
                error: "Review ID must be a valid number",
            });
            return;
        }
        const { reviewedBy, note } = req.body ?? {};
        const review = await marketRateService.rejectPendingReview(reviewId, reviewedBy, note);
        res.json({
            success: true,
            data: review,
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error
                ? error.message
                : "Failed to reject price review",
        });
    }
});
// Health check
router.get("/health", cacheMiddleware({
    ttl: 60,
    keyGenerator: () => CACHE_KEYS.marketRates.health(),
}), async (req, res) => {
    try {
        const health = await marketRateService.healthCheck();
        res.json({
            success: true,
            data: health,
            overallHealthy: Object.values(health).every((status) => status),
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : "Internal server error",
        });
    }
});
// Supported currencies
router.get("/currencies", cacheMiddleware({
    ttl: CACHE_CONFIG.ttl.marketRates,
    keyGenerator: () => CACHE_KEYS.marketRates.currencies(),
}), (req, res) => {
    try {
        const currencies = marketRateService.getSupportedCurrencies();
        res.json({
            success: true,
            data: currencies,
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : "Internal server error",
        });
    }
});
// Cache status
router.get("/cache", (req, res) => {
    try {
        const cacheStatus = marketRateService.getCacheStatus();
        res.json({
            success: true,
            data: cacheStatus,
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : "Internal server error",
        });
    }
});
// Clear cache
router.post("/cache/clear", (req, res) => {
    try {
        marketRateService.clearCache();
        res.json({
            success: true,
            message: "Cache cleared successfully",
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : "Internal server error",
        });
    }
});
export default router;
//# sourceMappingURL=marketRates.js.map