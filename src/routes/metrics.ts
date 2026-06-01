import express, { Request, Response } from "express";
import { register, metricsEndpoint } from "../middleware/metrics";

const router = express.Router();

/**
 * @swagger
 * /api/v1/metrics:
 *   get:
 *     tags:
 *       - Metrics
 *     summary: List available metrics endpoints
 *     description: Returns the available metrics exporter and Prometheus-style endpoints.
 *     responses:
 *       '200':
 *         description: Metrics endpoint metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 endpoints:
 *                   type: object
 */
router.get("/", (_req: Request, res: Response) => {
  res.json({
    success: true,
    endpoints: {
      exporter: "/api/v1/metrics/exporter",
      prometheus: "/api/v1/metrics/prometheus",
    },
  });
});

/**
 * @swagger
 * /api/v1/metrics/exporter:
 *   get:
 *     tags:
 *       - Metrics
 *     summary: Export structured performance metrics
 *     description: Returns internal pipeline execution metrics in JSON format for dashboards and monitoring tools.
 *     responses:
 *       '200':
 *         description: Structured metrics payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 metrics:
 *                   type: array
 *                   items:
 *                     type: object
 */
router.get("/exporter", async (_req: Request, res: Response) => {
  try {
    const metrics = await register.getMetricsAsJSON();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      metrics,
    });
  } catch (error) {
    console.error("Metrics exporter failed:", error);
    res.status(500).json({
      success: false,
      error: "Failed to read metrics",
    });
  }
});

/**
 * @swagger
 * /api/v1/metrics/prometheus:
 *   get:
 *     tags:
 *       - Metrics
 *     summary: Prometheus compatible metrics endpoint
 *     description: Returns Prometheus text format metrics for scraping.
 *     responses:
 *       '200':
 *         description: Prometheus metrics payload
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 */
router.get("/prometheus", metricsEndpoint);

export default router;
