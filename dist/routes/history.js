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
 * /api/history/{asset}:
 *   get:
 *     tags:
 *       - History
 *     summary: Get price history for an asset
 *     description: Retrieve historical price data for a specific asset within a specified time range
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
 *           default: '7d'
 *         description: Time range for historical data
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
 *         description: Invalid range parameter
 *       '404':
 *         description: No history found for the asset
 *       '500':
 *         description: Internal server error
 */
// GET /api/history/:asset?range=7d
router.get("/:asset", async (req, res) => {
    const asset = req.params.asset.toUpperCase();
    const rangeParam = req.query.range ?? "7d";
    const days = RANGE_MAP[rangeParam];
    if (!days) {
        res.status(400).json({
            success: false,
            error: `Invalid range. Supported values: ${Object.keys(RANGE_MAP).join(", ")}`,
        });
        return;
    }
    try {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const rows = await prisma.priceHistory.findMany({
            where: {
                currency: asset,
                timestamp: { gte: since },
            },
            orderBy: { timestamp: "asc" },
            select: { timestamp: true, rate: true, source: true },
        });
        if (rows.length === 0) {
            res.status(404).json({
                success: false,
                error: `No history found for ${asset} in the last ${rangeParam}`,
            });
            return;
        }
        res.json({
            success: true,
            asset,
            range: rangeParam,
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