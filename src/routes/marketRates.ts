
import { Router } from "express";
import { getRate, getAllRates } from "../controllers/marketRatesController";
import { MarketRateService } from "../services/marketRate";

const marketRateService = new MarketRateService();

/**
 * @swagger
 * /api/market-rates/rate/{currency}:
 *   get:
 *     tags:
 *       - Market Rates
 *     summary: Get exchange rate for a specific currency
 *     description: Fetch the current exchange rate for a specified currency
 *     parameters:
 *       - in: path
 *         name: currency
 *         required: true
 *         schema:
 *           type: string
 *         description: Currency code (e.g., GHS, NGN, KES)
 *         example: GHS
 *     responses:
 *       '200':
 *         description: Successfully retrieved exchange rate
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/MarketRate'
 *       '404':
 *         description: Currency not found
 *       '500':
 *         description: Internal server error
 */
const router = Router();

// Get rate for specific currency
router.get("/rate/:currency", getRate);

/**
 * @swagger
 * /api/market-rates/rates:
 *   get:
 *     tags:
 *       - Market Rates
 *     summary: Get all available exchange rates
 *     description: Fetch the current exchange rates for all supported currencies
 *     responses:
 *       '200':
 *         description: Successfully retrieved all exchange rates
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/MarketRate'
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: string
 *       '500':
 *         description: Internal server error
 */
// Get all available rates
router.get("/rates", getAllRates);



/**
 * @swagger
 * /api/market-rates/latest:
 *   get:
 *     tags:
 *       - Market Rates
 *     summary: Get latest prices
 *     description: Fetch the latest prices for all supported currencies with any errors encountered during fetching
 *     responses:
 *       '200':
 *         description: Successfully retrieved latest prices
 *       '500':
 *         description: Internal server error
 */
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
    } else {
      res.status(500).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error("Error fetching latest prices:", error);

    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to fetch latest prices",
    });
  }
});

/**
 * @swagger
 * /api/market-rates/reviews/pending:
 *   get:
 *     tags:
 *       - Market Rates
 *     summary: Get pending price reviews
 *     description: Retrieve all pending price reviews awaiting approval
 *     responses:
 *       '200':
 *         description: Successfully retrieved pending reviews
 *       '500':
 *         description: Internal server error
 */
router.get("/reviews/pending", async (req, res) => {
  try {
    const reviews = await marketRateService.getPendingReviews();

    res.json({
      success: true,
      data: reviews,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to fetch pending price reviews",
    });
  }
});

/**
 * @swagger
 * /api/market-rates/reviews/{id}/approve:
 *   post:
 *     tags:
 *       - Market Rates
 *     summary: Approve a pending price review
 *     description: Approve a pending price review with reviewer notes
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Review ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reviewedBy:
 *                 type: string
 *               note:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Review approved successfully
 *       '400':
 *         description: Invalid review ID
 *       '500':
 *         description: Internal server error
 */
router.post("/reviews/:id/approve", async (req, res) => {
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
    const review = await marketRateService.approvePendingReview(
      reviewId,
      reviewedBy,
      note,
    );

    res.json({
      success: true,
      data: review,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to approve price review",
    });
  }
});

/**
 * @swagger
 * /api/market-rates/reviews/{id}/reject:
 *   post:
 *     tags:
 *       - Market Rates
 *     summary: Reject a pending price review
 *     description: Reject a pending price review with reviewer notes
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Review ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reviewedBy:
 *                 type: string
 *               note:
 *                 type: string
 *     responses:
 *       '200':
 *         description: Review rejected successfully
 *       '400':
 *         description: Invalid review ID
 *       '500':
 *         description: Internal server error
 */
router.post("/reviews/:id/reject", async (req, res) => {
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
    const review = await marketRateService.rejectPendingReview(
      reviewId,
      reviewedBy,
      note,
    );

    res.json({
      success: true,
      data: review,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to reject price review",
    });
  }
});

/**
 * @swagger
 * /api/market-rates/health:
 *   get:
 *     tags:
 *       - Market Rates
 *     summary: Health check for market rate fetchers
 *     description: Check the health status of all market rate data fetchers
 *     responses:
 *       '200':
 *         description: Health status retrieved successfully
 *       '500':
 *         description: Internal server error
 */
// Health check for all fetchers
router.get("/health", async (req, res) => {
  try {
    const health = await marketRateService.healthCheck();

    res.json({
      success: true,
      data: health,
      overallHealthy: Object.values(health).every((status) => status),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

/**
 * @swagger
 * /api/market-rates/currencies:
 *   get:
 *     tags:
 *       - Market Rates
 *     summary: Get supported currencies
 *     description: Retrieve a list of all supported currency codes
 *     responses:
 *       '200':
 *         description: Successfully retrieved supported currencies
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: string
 *       '500':
 *         description: Internal server error
 */
// Get supported currencies
router.get("/currencies", (req, res) => {
  try {
    const currencies = marketRateService.getSupportedCurrencies();

    res.json({
      success: true,
      data: currencies,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

/**
 * @swagger
 * /api/market-rates/cache:
 *   get:
 *     tags:
 *       - Market Rates
 *     summary: Get cache status
 *     description: Retrieve the current status of the market rates cache
 *     responses:
 *       '200':
 *         description: Successfully retrieved cache status
 *       '500':
 *         description: Internal server error
 */
// Get cache status
router.get("/cache", (req, res) => {
  try {
    const cacheStatus = marketRateService.getCacheStatus();

    res.json({
      success: true,
      data: cacheStatus,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

/**
 * @swagger
 * /api/market-rates/cache/clear:
 *   post:
 *     tags:
 *       - Market Rates
 *     summary: Clear the market rates cache
 *     description: Clear all cached market rate data to force a fresh fetch
 *     responses:
 *       '200':
 *         description: Cache cleared successfully
 *       '500':
 *         description: Internal server error
 */
// Clear cache
router.post("/cache/clear", (req, res) => {
  try {
    marketRateService.clearCache();

    res.json({
      success: true,
      message: "Cache cleared successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export default router;
