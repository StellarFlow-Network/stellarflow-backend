/**
 * Analytics Routes – Issue #208
 *
 * Mounts analytics endpoints under /api/v1/analytics
 *
 * Endpoints:
 *   GET /api/v1/analytics/ohlc   – OHLC candlestick data (see analyticsController)
 *   GET /api/v1/analytics/status – PriceAggregator worker health
 */

import { Router, Request, Response } from "express";
import { getOhlcCandles } from "../controllers/analyticsController.js";
import { priceAggregatorService } from "../services/priceAggregatorService.js";

const router = Router();

/**
 * @swagger
 * /api/v1/analytics/ohlc:
 *   get:
 *     tags:
 *       - Analytics
 *     summary: Fetch OHLC candlestick data
 *     description: >
 *       Returns pre-aggregated Open/High/Low/Close candle data for a given
 *       currency and time granularity (MINUTE | HOUR | DAY).
 *       Candles are produced by the PriceAggregator background worker.
 *     parameters:
 *       - in: query
 *         name: currency
 *         required: true
 *         schema: { type: string }
 *         example: NGN
 *       - in: query
 *         name: granularity
 *         required: true
 *         schema:
 *           type: string
 *           enum: [MINUTE, HOUR, DAY]
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
 *     responses:
 *       '200':
 *         description: Candle data
 *       '400':
 *         description: Invalid parameters
 *       '500':
 *         description: Server error
 */
router.get("/ohlc", getOhlcCandles);

/**
 * GET /api/v1/analytics/status
 * Returns the current health / run-state of the PriceAggregator worker.
 *
 * @swagger
 * /api/v1/analytics/status:
 *   get:
 *     tags:
 *       - Analytics
 *     summary: PriceAggregator worker status
 *     description: Returns whether the OHLC aggregation worker is running and which granularities are scheduled.
 *     responses:
 *       '200':
 *         description: Worker status
 */
router.get("/status", (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: priceAggregatorService.getStatus(),
  });
});

export default router;
