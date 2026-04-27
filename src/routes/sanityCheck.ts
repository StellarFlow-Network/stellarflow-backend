import { Router } from "express";
import { sanityCheckService } from "../services/sanityCheckService";
import prisma from "../lib/prisma";

const router = Router();

/**
 * @swagger
 * /api/v1/sanity-check/check/{currency}:
 *   get:
 *     tags:
 *       - Sanity Check
 *     summary: Perform sanity check for a specific currency
 *     description: Compare Oracle price with external sources for a currency
 *     parameters:
 *       - in: path
 *         name: currency
 *         required: true
 *         schema:
 *           type: string
 *         description: Currency code (e.g., NGN, KES, GHS)
 *     responses:
 *       '200':
 *         description: Sanity check completed
 *       '404':
 *         description: No recent price found for currency
 *       '500':
 *         description: Internal server error
 */
router.get("/check/:currency", async (req, res) => {
  try {
    const currency = req.params.currency.toUpperCase();

    // Get latest Oracle price from database
    const latestPrice = await prisma.priceHistory.findFirst({
      where: { currency },
      orderBy: { timestamp: "desc" },
    });

    if (!latestPrice) {
      res.status(404).json({
        success: false,
        error: `No recent price found for ${currency}`,
      });
      return;
    }

    const result = await sanityCheckService.checkPrice(
      currency,
      Number(latestPrice.rate),
    );

    if (!result) {
      res.status(500).json({
        success: false,
        error: "Unable to fetch external price for comparison",
      });
      return;
    }

    res.json({
      success: true,
      data: result,
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
 * /api/v1/sanity-check/check-all:
 *   get:
 *     tags:
 *       - Sanity Check
 *     summary: Perform sanity check for all currencies
 *     description: Compare Oracle prices with external sources for all supported currencies
 *     responses:
 *       '200':
 *         description: Sanity checks completed
 *       '500':
 *         description: Internal server error
 */
router.get("/check-all", async (req, res) => {
  try {
    // Get latest prices for all currencies
    const currencies = ["NGN", "KES", "GHS"];
    const prices: Array<{ currency: string; price: number }> = [];

    for (const currency of currencies) {
      const latestPrice = await prisma.priceHistory.findFirst({
        where: { currency },
        orderBy: { timestamp: "desc" },
      });

      if (latestPrice) {
        prices.push({
          currency,
          price: Number(latestPrice.rate),
        });
      }
    }

    const results = await sanityCheckService.checkPrices(prices);

    const summary = {
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
    };

    res.json({
      success: true,
      summary,
      data: results,
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
 * /api/v1/sanity-check/threshold:
 *   get:
 *     tags:
 *       - Sanity Check
 *     summary: Get sanity check threshold
 *     description: Retrieve the current deviation threshold percentage
 *     responses:
 *       '200':
 *         description: Threshold retrieved successfully
 */
router.get("/threshold", (req, res) => {
  try {
    const threshold = sanityCheckService.getThreshold();

    res.json({
      success: true,
      data: {
        threshold,
        description: `Alerts are triggered when price deviation exceeds ${threshold}%`,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export default router;
