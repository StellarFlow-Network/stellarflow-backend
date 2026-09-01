import { Request, Response, NextFunction } from "express";
import promClient from "prom-client";

// Create a Registry which registers the metrics
export const register = new promClient.Registry();

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
});
register.registerMetric(ingestionQueueDepth);

/**
 * NEW: Dropped Packets Counter
 * Tracks how many packets were dropped due to saturation/backpressure
 */
export const droppedPacketsTotal = new promClient.Counter({
  name: "ingestion_dropped_packets_total",
  help: "Total number of packets dropped by the backpressure manager",
  labelNames: ["priority"],
});
register.registerMetric(droppedPacketsTotal);

// Custom histogram for HTTP request durations
export const httpRequestDurationMicroseconds = new promClient.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
});
register.registerMetric(httpRequestDurationMicroseconds);

// Custom counter for HTTP requests
export const httpRequestsTotal = new promClient.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
});
register.registerMetric(httpRequestsTotal);

export const successfulSubmissions = new promClient.Counter({
  name: "multi_sig_successful_submissions_total",
  help: "Total successful multi-sig submissions",
  labelNames: ["asset"],
});
register.registerMetric(successfulSubmissions);

export const failedSubmissions = new promClient.Counter({
  name: "multi_sig_failed_submissions_total",
  help: "Total failed multi-sig submissions",
  labelNames: ["asset", "reason"],
});
register.registerMetric(failedSubmissions);

export const gasUsagePerAsset = new promClient.Histogram({
  name: "multi_sig_gas_usage_stroops",
  help: "Gas usage per asset in stroops",
  labelNames: ["asset"],
  buckets: [100000, 500000, 1000000, 5000000, 10000000],
});
register.registerMetric(gasUsagePerAsset);

export const submissionDuration = new promClient.Histogram({
  name: "multi_sig_submission_duration_seconds",
  help: "Duration of multi-sig submission flow in seconds",
  labelNames: ["asset"],
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
      status_code: res.statusCode,
    });

    httpRequestDurationMicroseconds.observe(
      {
        method: req.method,
        route: routeStr,
        status_code: res.statusCode,
      },
      durationSeconds,
    );
  });

  next();
};

export const metricsEndpoint = async (req: Request, res: Response) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
};
