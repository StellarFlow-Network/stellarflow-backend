import { Router } from "express";
import { intelligenceService } from "../services/intelligenceService";

const router = Router();

/**
 * @swagger
 * /api/v1/intelligence/price-change/{currency}:
 *   get:
 *     tags:
 *       - Intelligence
 *     summary: Get 24-hour price change percentage
 *     description: Calculate the percentage change in price for a given currency compared to 24 hours ago
 *     parameters:
 *       - in: path
 *         name: currency
 *         required: true
 *         schema:
 *           type: string
 *         description: Currency code (e.g., NGN, GHS, KES)
 *         example: NGN
 *     responses:
 *       '200':
 *         description: Successfully calculated price change
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 currency:
 *                   type: string
 *                 change24h:
 *                   type: string
 *                   example: "+2.5%"
 *       '500':
 *         description: Internal server error
 */
router.get("/price-change/:currency", async (req, res) => {
  const currency = req.params.currency.toUpperCase();
  
  try {
    const change = await intelligenceService.calculate24hPriceChange(currency);
    
    res.json({
      success: true,
      currency,
      change24h: change,
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
 * /api/v1/intelligence/stale:
 *   get:
 *     tags:
 *       - Intelligence
 *     summary: Get a list of stale currencies
 *     description: Identify currencies that haven't been updated in the database for over 30 minutes
 *     responses:
 *       '200':
 *         description: Successfully retrieved stale currencies
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 staleCurrencies:
 *                   type: array
 *                   items:
 *                     type: string
 *       '500':
 *         description: Internal server error
 */
router.get("/stale", async (req, res) => {
  try {
    const staleCurrencies = await intelligenceService.getStaleCurrencies();
    
    res.json({
      success: true,
      staleCurrencies,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export default router;
