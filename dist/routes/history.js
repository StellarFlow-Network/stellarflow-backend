import { Router } from "express";
import prisma from "../lib/prisma";
const router = Router();
const RANGE_MAP = {
    "1d": 1,
    "7d": 7,
    "30d": 30,
    "90d": 90,
};
/**
 * @swagger
 * /api/v1/history/{asset}:
 *   get:
 *     tags:
 *       - History
 *     summary: Get price history for an asset
 *     description: Retrieve historical price data for a specific asset within a specified time range or date range
 *     parameters:
 *       - in: path
 *         name: asset
 *         required: true
 *         schema:
 *           type: string
 *         description: Asset code (e.g., GHS, NGN, KES)
 *         example: GHS
 *       - in: query
 *         name: range
 *         schema:
 *           type: string
 *           enum: ['1d', '7d', '30d', '90d']
 *         description: Predefined time range for historical data (ignored if from/to are provided)
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date for historical data (ISO 8601)
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date for historical data (ISO 8601)
 *     responses:
 *       '200':
 *         description: Successfully retrieved price history
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 asset:
 *                   type: string
 *                 range:
 *                   type: string
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PriceHistory'
 *       '400':
 *         description: Invalid range or date parameters
 *       '404':
 *         description: No history found for the asset
 *       '500':
 *         description: Internal server error
 */
// GET /api/v1/history/:asset?range=7d
// GET /api/v1/history/:asset?from=2024-01-01&to=2024-01-07
router.get("/:asset", async (req, res) => {
    const asset = req.params.asset.toUpperCase();
    const rangeParam = req.query.range;
    const fromParam = req.query.from;
    const toParam = req.query.to;
    let since;
    let until;
    if (fromParam || toParam) {
        if (fromParam) {
            since = new Date(fromParam);
            if (isNaN(since.getTime())) {
                res.status(400).json({ success: false, error: "Invalid 'from' date" });
                return;
            }
        }
        if (toParam) {
            until = new Date(toParam);
            if (isNaN(until.getTime())) {
                res.status(400).json({ success: false, error: "Invalid 'to' date" });
                return;
            }
        }
    }
    else {
        const range = rangeParam ?? "7d";
        const days = RANGE_MAP[range];
        if (!days) {
            res.status(400).json({
                success: false,
                error: `Invalid range. Supported values: ${Object.keys(RANGE_MAP).join(", ")}`,
            });
            return;
        }
        since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    }
    try {
        const where = {
            currency: asset,
            timestamp: {},
        };
        if (since)
            where.timestamp.gte = since;
        if (until)
            where.timestamp.lte = until;
        const rows = await prisma.priceHistory.findMany({
            where,
            orderBy: { timestamp: "asc" },
            select: { timestamp: true, rate: true, source: true },
        });
        if (rows.length === 0) {
            res.status(404).json({
                success: false,
                error: `No history found for ${asset} in the specified timeframe`,
            });
            return;
        }
        res.json({
            success: true,
            asset,
            range: rangeParam || "custom",
            data: rows.map((r) => ({
                timestamp: r.timestamp.toISOString(),
                rate: Number(r.rate),
                source: r.source,
            })),
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
//# sourceMappingURL=history.js.map