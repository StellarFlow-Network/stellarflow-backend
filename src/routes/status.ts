import { Router } from "express";
import prisma from "../lib/prisma";

const router = Router();

/**
 * @swagger
 * /api/v1/status:
 *   get:
 *     tags:
 *       - Status
 *     summary: System status
 *     description: Returns DB health and last successful price sync time for dashboard indicators
 *     responses:
 *       '200':
 *         description: System status (green or red)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [green, red]
 *                 db:
 *                   type: string
 *                   enum: [ok, error]
 *                 lastSync:
 *                   type: string
 *                   format: date-time
 *                   nullable: true
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.get("/", async (req, res) => {
  let dbOk = false;
  let lastSync: string | null = null;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;

    // Last successful price sync = most recent PriceHistory entry
    const latest = await prisma.priceHistory.findFirst({
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    });

    lastSync = latest?.timestamp?.toISOString() ?? null;
  } catch {
    dbOk = false;
  }

  res.json({
    status: dbOk ? "green" : "red",
    db: dbOk ? "ok" : "error",
    lastSync,
    timestamp: new Date().toISOString(),
  });
});

export default router;
