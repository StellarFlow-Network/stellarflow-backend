import { Router, Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import { collateralFactorService } from "../services/collateralFactorService";

const router = Router();

function parseAssets(raw: unknown): string[] | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const assets = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return assets.length > 0 ? assets : undefined;
}

/**
 * GET /api/v1/risk/collateral-factors
 *
 * Returns active vault risk parameters: dynamic collateral valuation factor M_i
 * for every collateral asset, derived from rolling 7-day liquidity depth.
 * Assets whose liquidity dropped below the threshold expose belowThreshold: true
 * and an automatically reduced valuationFactor.
 *
 * Responds from active cache in under 15ms.
 *
 * @swagger
 * /api/v1/risk/collateral-factors:
 *   get:
 *     tags: [Risk]
 *     summary: Active vault collateral valuation factors
 *     parameters:
 *       - in: query
 *         name: assets
 *         schema:
 *           type: string
 *         description: Optional comma-separated collateral asset codes.
 *       - in: query
 *         name: refresh
 *         schema:
 *           type: boolean
 *         description: Optional flag to force dynamic recomputation instead of active cache.
 *     responses:
 *       200:
 *         description: Active collateral factor report.
 */
router.get("/collateral-factors", async (req: Request, res: Response) => {
  try {
    const assets = parseAssets(req.query.assets);
    const forceRefresh = req.query.refresh === "true";
    const report = await collateralFactorService.getCollateralFactors({
      assets,
      forceRefresh,
    });
    res.json({ success: true, data: report });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error ? error.message : "Failed to compute collateral factors",
    );
  }
});

export default router;
