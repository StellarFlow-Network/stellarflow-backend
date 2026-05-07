/**
 * Analytics Controller – Issue #208
 *
 * Handles GET /api/v1/analytics/ohlc
 *
 * Query parameters:
 *   currency     {string}  Required. e.g. "NGN", "KES", "GHS"
 *   granularity  {string}  Required. "MINUTE" | "HOUR" | "DAY"
 *   from         {string}  Optional. ISO-8601 start time (default: 24 h ago for HOUR/MINUTE, 30 d ago for DAY)
 *   to           {string}  Optional. ISO-8601 end time   (default: now)
 *   limit        {number}  Optional. Max candles to return (default: 100, max: 500)
 */

import { Request, Response } from "express";
import prisma from "../lib/prisma.js";

type Granularity = "MINUTE" | "HOUR" | "DAY";

const VALID_GRANULARITIES: Granularity[] = ["MINUTE", "HOUR", "DAY"];

/** Default look-back per granularity when `from` is not provided */
const DEFAULT_LOOKBACK_MS: Record<Granularity, number> = {
  MINUTE: 60 * 60_000, // 1 hour   of minute candles
  HOUR: 7 * 24 * 60 * 60_000, // 7 days   of hourly candles
  DAY: 90 * 24 * 60 * 60_000, // 90 days  of daily  candles
};

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/**
 * GET /api/v1/analytics/ohlc
 *
 * @swagger
 * /api/v1/analytics/ohlc:
 *   get:
 *     tags:
 *       - Analytics
 *     summary: OHLC candlestick data
 *     description: >
 *       Returns Open/High/Low/Close candle data aggregated from live price-feed
 *       ticks. Candles are pre-computed by the PriceAggregator worker on a
 *       cron schedule (MINUTE every 1 min, HOUR every 5 min, DAY every 15 min).
 *     parameters:
 *       - in: query
 *         name: currency
 *         required: true
 *         schema:
 *           type: string
 *         example: NGN
 *         description: Currency code (e.g. NGN, KES, GHS)
 *       - in: query
 *         name: granularity
 *         required: true
 *         schema:
 *           type: string
 *           enum: [MINUTE, HOUR, DAY]
 *         description: Candle granularity
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start of time range (ISO-8601, default varies by granularity)
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End of time range (ISO-8601, default now)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 500
 *           default: 100
 *         description: Maximum number of candles to return
 *     responses:
 *       '200':
 *         description: Candle data returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     currency:
 *                       type: string
 *                     granularity:
 *                       type: string
 *                     from:
 *                       type: string
 *                       format: date-time
 *                     to:
 *                       type: string
 *                       format: date-time
 *                     count:
 *                       type: integer
 *                     candles:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/OhlcCandle'
 *       '400':
 *         description: Invalid query parameters
 *       '500':
 *         description: Internal server error
 */
export async function getOhlcCandles(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    // ------------------------------------------------------------------
    // 1. Parse & validate query parameters
    // ------------------------------------------------------------------
    const { currency, granularity, from, to, limit: limitParam } = req.query;

    if (!currency || typeof currency !== "string") {
      res.status(400).json({
        success: false,
        error: "Query parameter `currency` is required (e.g. NGN, KES, GHS).",
      });
      return;
    }

    const upperCurrency = currency.toUpperCase();

    if (!granularity || typeof granularity !== "string") {
      res.status(400).json({
        success: false,
        error:
          "Query parameter `granularity` is required. Valid values: MINUTE | HOUR | DAY.",
      });
      return;
    }

    const upperGranularity = granularity.toUpperCase() as Granularity;
    if (!VALID_GRANULARITIES.includes(upperGranularity)) {
      res.status(400).json({
        success: false,
        error: `Invalid granularity "${granularity}". Valid values: ${VALID_GRANULARITIES.join(", ")}.`,
      });
      return;
    }

    const now = new Date();
    const defaultLookback = DEFAULT_LOOKBACK_MS[upperGranularity];

    const toDate = to ? new Date(to as string) : now;
    if (isNaN(toDate.getTime())) {
      res.status(400).json({
        success: false,
        error: "Invalid `to` date. Use ISO-8601 format.",
      });
      return;
    }

    const fromDate = from
      ? new Date(from as string)
      : new Date(toDate.getTime() - defaultLookback);
    if (isNaN(fromDate.getTime())) {
      res.status(400).json({
        success: false,
        error: "Invalid `from` date. Use ISO-8601 format.",
      });
      return;
    }

    if (fromDate >= toDate) {
      res.status(400).json({
        success: false,
        error: "`from` must be earlier than `to`.",
      });
      return;
    }

    let limit = DEFAULT_LIMIT;
    if (limitParam !== undefined) {
      const parsed = parseInt(limitParam as string, 10);
      if (isNaN(parsed) || parsed < 1) {
        res.status(400).json({
          success: false,
          error: "`limit` must be a positive integer.",
        });
        return;
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }

    // ------------------------------------------------------------------
    // 2. Query OhlcCandle table
    // ------------------------------------------------------------------
    const candles = await prisma.ohlcCandle.findMany({
      where: {
        currency: upperCurrency,
        granularity: upperGranularity,
        openTime: {
          gte: fromDate,
          lt: toDate,
        },
      },
      orderBy: { openTime: "asc" },
      take: limit,
      select: {
        openTime: true,
        closeTime: true,
        open: true,
        high: true,
        low: true,
        close: true,
        count: true,
      },
    });

    // ------------------------------------------------------------------
    // 3. Serialise (Decimal → string for wire safety)
    // ------------------------------------------------------------------
    const serialised = candles.map((c) => ({
      openTime: c.openTime.toISOString(),
      closeTime: c.closeTime.toISOString(),
      open: c.open.toString(),
      high: c.high.toString(),
      low: c.low.toString(),
      close: c.close.toString(),
      count: c.count,
    }));

    res.json({
      success: true,
      data: {
        currency: upperCurrency,
        granularity: upperGranularity,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        count: serialised.length,
        candles: serialised,
      },
    });
  } catch (error) {
    console.error("[AnalyticsController] getOhlcCandles error:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
