import { Router } from "express";
import prisma from "../lib/prisma";
import { getRedisClient } from "../lib/redis";

const router = Router();

/**
 * @swagger
 * /api/health/live:
 *   get:
 *     tags:
 *       - Health
 *     summary: Liveness probe
 *     description: Returns 200 if the process is alive. Used by orchestrators to decide whether to restart the container.
 *     responses:
 *       '200':
 *         description: Process is alive
 */
router.get("/live", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * @swagger
 * /api/health/ready:
 *   get:
 *     tags:
 *       - Health
 *     summary: Readiness probe
 *     description: Returns 200 only when both PostgreSQL and Redis (if configured) are reachable.
 *     responses:
 *       '200':
 *         description: All dependencies healthy
 *       '503':
 *         description: One or more dependencies unavailable
 */
router.get("/ready", async (_req, res) => {
  const checks: Record<string, "ok" | "error"> = {};

  // Database check
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = "ok";
  } catch {
    checks.db = "error";
  }

  // Redis check (only if configured)
  const redisClient = getRedisClient();
  if (redisClient) {
    try {
      await redisClient.ping();
      checks.redis = "ok";
    } catch {
      checks.redis = "error";
    }
  }

  const healthy = Object.values(checks).every((v) => v === "ok");

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "unhealthy",
    checks,
  });
});

export default router;
