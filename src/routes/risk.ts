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
 * Returns the active vault risk parameters: the dynamic collateral valuation
 * factor for every collateral asset, derived from 7-day liquidity depth. Assets
 * whose liquidity dropped below the threshold expose `belowThreshold: true` and
 * a reduced `valuationFactor`.
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
 *     responses:
 *       200:
 *         description: Collateral factor report.
 */
router.get("/collateral-factors", async (req: Request, res: Response) => {
  try {
    const assets = parseAssets(req.query.assets);
    const report = await collateralFactorService.getCollateralFactors(
      assets ? { assets } : {},
    );
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
