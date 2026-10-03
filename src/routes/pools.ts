import { Router } from "express";
import prisma from "../lib/prisma";

const router = Router();

/**
 * @swagger
 * /api/v1/pools/{address}/fee-recommendation:
 *   get:
 *     tags:
 *       - Pools
 *     summary: Get optimal fee tier recommendation
 *     description: Calculate 24-hour annualized pool volatility using price sample histories and recommend fee tier to minimize impermanent loss.
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool address
 *     responses:
 *       '200':
 *         description: Successfully calculated fee recommendation
 *       '500':
 *         description: Internal server error
 */
router.get("/:address/fee-recommendation", async (req, res) => {
  try {
    const { address } = req.params;
    
    // We fetch candles for the last 24 hours to use as price sample histories.
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const candles = await prisma.ohlcCandle.findMany({
      where: {
        currency: address,
        openTime: { gte: twentyFourHoursAgo }
      },
      orderBy: { openTime: "asc" },
      select: { close: true }
    });

    // Need at least 2 price points to compute a return
    if (candles.length < 2) {
      return res.json({
        success: true,
        recommendedFeeTier: "0.30%",
        volatility24h: 0,
        message: "Insufficient price history for volatility calculation. Defaulting to 0.30%."
      });
    }

    const returns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const p0 = Number(candles[i - 1].close);
      const p1 = Number(candles[i].close);
      if (p0 > 0 && p1 > 0) {
        returns.push(Math.log(p1 / p0));
      }
    }

    if (returns.length === 0) {
      return res.json({
        success: true,
        recommendedFeeTier: "0.30%",
        volatility24h: 0,
        message: "Invalid price history data."
      });
    }

    // Calculate sample standard deviation of returns
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length - 1 || 1);
    const stdDev = Math.sqrt(variance);

    // Annualize the volatility (assuming the sample count reflects the daily frequency)
    const periodsPerYear = candles.length * 365;
    const annualizedVolatility = stdDev * Math.sqrt(periodsPerYear);

    // Recommend fee tier minimizing expected impermanent loss
    // f in {0.05%, 0.30%, 1.00%}
    let recommendedFeeTier = "0.30%";
    if (annualizedVolatility < 0.10) {
      recommendedFeeTier = "0.05%";
    } else if (annualizedVolatility > 0.50) {
      recommendedFeeTier = "1.00%";
    } else {
      recommendedFeeTier = "0.30%";
    }

    res.json({
      success: true,
      poolAddress: address,
      recommendedFeeTier,
      volatility24h: annualizedVolatility,
      sampleCount: candles.length
    });

  } catch (error) {
    console.error("Error calculating fee recommendation:", error);
    res.status(500).json({ success: false, message: "INTERNAL_SERVER_ERROR" });
  }
});

export default router;
