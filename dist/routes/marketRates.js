import { Router } from "express";
import { MarketRateService } from "../services/marketRate";
const router = Router();
const marketRateService = new MarketRateService();
// Get rate for specific currency
router.get("/rate/:currency", async (req, res) => {
    try {
        const { currency } = req.params;
        const result = await marketRateService.getRate(currency);
        if (result.success) {
            res.json({
                success: true,
                data: result.data,
            });
        }
        else {
            res.status(404).json({
                success: false,
                error: result.error,
            });
        }
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : "Internal server error",
        });
    }
});
// Get all available rates
router.get("/rates", async (req, res) => {
    try {
        const results = await marketRateService.getAllRates();
        const rates = results
            .filter((result) => result.success)
            .map((result) => result.data);
        const errors = results.filter((result) => !result.success);
        res.json({
            success: true,
            data: rates,
            errors: errors.length > 0 ? errors.map((e) => e.error) : undefined,
        });
    }
    catch (error) {
        res.status(500).json({
            success: false,
            error: error instanceof Error ? error.message : "Internal server error",
        });
    }
});
// GET /api/market-rates/latest
router.get("/latest", async (req, res) => {
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
// Health check for all fetchers
router.get("/health", async (req, res) => {
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
// Get supported currencies
router.get("/currencies", (req, res) => {
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
// Get cache status
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