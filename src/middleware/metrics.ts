import { Request, Response, NextFunction } from "express";
import promClient from "prom-client";
import prisma from "../lib/prisma";

// Create a Registry which registers the metrics
export const register = new promClient.Registry();

const environment = process.env.NODE_ENV || "development";

// Add default metrics (e.g., memory, CPU)
promClient.collectDefaultMetrics({
  register,
  labels: { app: "stellarflow-backend" },
});

/** * NEW: Ingestion Queue Metrics
 * Tracks the current depth of the backpressure queue
 */
export const ingestionQueueDepth = new promClient.Gauge({
  name: "ingestion_queue_depth",
  help: "Current number of items in the backpressure queue",
  labelNames: ["environment"],
});
register.registerMetric(ingestionQueueDepth);

/**
 * Worker Queue Depth Metric
 */
export const workerQueueDepth = new promClient.Gauge({
  name: "worker_queue_depth",
  help: "Current depth of the worker queue",
  labelNames: ["environment"],
});
register.registerMetric(workerQueueDepth);

/**
 * Database Connection Pool Status Metrics
 */
export const databaseConnectionPoolStatus = new promClient.Gauge({
  name: "database_connection_pool_status",
  help: "Database connection pool metrics (active, idle, max)",
  labelNames: ["environment", "status"],
});
register.registerMetric(databaseConnectionPoolStatus);

/**
 * Dropped Packets Counter
 * Tracks how many packets were dropped due to saturation/backpressure
 */
export const droppedPacketsTotal = new promClient.Counter({
  name: "ingestion_dropped_packets_total",
  help: "Total number of packets dropped by the backpressure manager",
  labelNames: ["priority", "environment"],
});
register.registerMetric(droppedPacketsTotal);

// Custom histogram for HTTP request durations
export const httpRequestDurationMicroseconds = new promClient.Histogram({
  name: "request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code", "environment"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
});
register.registerMetric(httpRequestDurationMicroseconds);

// Custom counter for HTTP requests
export const httpRequestsTotal = new promClient.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code", "environment"],
});
register.registerMetric(httpRequestsTotal);

export const successfulSubmissions = new promClient.Counter({
  name: "multi_sig_successful_submissions_total",
  help: "Total successful multi-sig submissions",
  labelNames: ["asset", "environment"],
});
register.registerMetric(successfulSubmissions);

export const failedSubmissions = new promClient.Counter({
  name: "multi_sig_failed_submissions_total",
  help: "Total failed multi-sig submissions",
  labelNames: ["asset", "reason", "environment"],
});
register.registerMetric(failedSubmissions);

export const gasUsagePerAsset = new promClient.Histogram({
  name: "multi_sig_gas_usage_stroops",
  help: "Gas usage per asset in stroops",
  labelNames: ["asset", "environment"],
  buckets: [100000, 500000, 1000000, 5000000, 10000000],
});
register.registerMetric(gasUsagePerAsset);

export const submissionDuration = new promClient.Histogram({
  name: "multi_sig_submission_duration_seconds",
  help: "Duration of multi-sig submission flow in seconds",
  labelNames: ["asset", "environment"],
  buckets: [1, 5, 10, 30, 60, 120],
});
register.registerMetric(submissionDuration);

export const metricsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const start = process.hrtime();

  res.on("finish", () => {
    const elapsed = process.hrtime(start);
    const durationSeconds = elapsed[0] + elapsed[1] / 1e9;

    let routeStr = "(unmatched)";
    if (req.route && req.route.path) {
      routeStr = req.baseUrl + req.route.path;
    } else {
      if (
        ["/health", "/", "/metrics"].includes(req.path) ||
        req.path.startsWith("/health/") ||
        req.path.startsWith("/api/v1/docs")
      ) {
        routeStr = req.path;
      }
    }

    httpRequestsTotal.inc({
      method: req.method,
      route: routeStr,
      status_code: res.statusCode.toString(),
      environment,
    });

    httpRequestDurationMicroseconds.observe(
      {
        method: req.method,
        route: routeStr,
        status_code: res.statusCode.toString(),
        environment,
      },
      durationSeconds,
    );
  });

  next();
};

export const metricsEndpoint = async (req: Request, res: Response) => {
  try {
    // Update dynamic gauges before scraping
    try {
      // @ts-ignore - metrics available on prisma pool if active
      const pool = prisma?._pool;
      if (pool) {
        databaseConnectionPoolStatus.set({ environment, status: "total" }, pool.totalCount || 0);
        databaseConnectionPoolStatus.set({ environment, status: "idle" }, pool.idleCount || 0);
        databaseConnectionPoolStatus.set({ environment, status: "waiting" }, pool.waitingCount || 0);
      } else {
        databaseConnectionPoolStatus.set({ environment, status: "total" }, 1);
        databaseConnectionPoolStatus.set({ environment, status: "idle" }, 1);
        databaseConnectionPoolStatus.set({ environment, status: "waiting" }, 0);
      }
    } catch {
      databaseConnectionPoolStatus.set({ environment, status: "total" }, 0);
    }

    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
};
