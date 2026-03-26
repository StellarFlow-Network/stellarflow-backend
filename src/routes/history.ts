import { Router } from "express";
import prisma from "../lib/prisma";

const router = Router();

const RANGE_MAP: Record<string, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

// GET /api/history/:asset?range=7d
router.get("/:asset", async (req, res) => {
  const asset = req.params.asset.toUpperCase();
  const rangeParam = (req.query.range as string) ?? "7d";
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
      data: rows.map((r: { timestamp: Date; rate: unknown; source: string }) => ({
        timestamp: r.timestamp.toISOString(),
        rate: Number(r.rate),
        source: r.source,
      })),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

export default router;
