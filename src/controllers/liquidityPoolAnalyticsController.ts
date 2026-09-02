import { Request, Response } from "express";
import { sendApiError } from "../lib/apiError.js";
import prisma from "../lib/prisma.js";

/** GET /api/v1/analytics/liquidity-pools */
export async function getLiquidityPoolAnalytics(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const poolId =
      typeof req.query.poolId === "string" ? req.query.poolId : undefined;
    if (req.query.poolId !== undefined && !poolId) {
      sendApiError(
        res,
        400,
        "BAD_REQUEST",
        "`poolId` must be a non-empty string.",
      );
      return;
    }
    const rows = await prisma.poolVolumeAnalytics.findMany({
      ...(poolId ? { where: { poolId } } : {}),
      orderBy: [{ poolId: "asc" }, { timestamp: "desc" }],
      distinct: ["poolId"],
    });
    const metrics = rows.map((row) => ({
      poolId: row.poolId,
      timestamp: row.timestamp,
      volume24h: Number(row.volume24h),
      fees24h: Number(row.fees24h),
      tvl: Number(row.tvl),
    }));
    res.json({ success: true, data: metrics });
  } catch (error) {
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      error instanceof Error
        ? error.message
        : "Unable to load liquidity pool analytics.",
    );
  }
}
