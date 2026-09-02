/**
 * Prometheus metrics used across services.
 * Re-exported from the central middleware/metrics module so every
 * service can import from "../metrics" without circular dependencies.
 */
import { Counter, Histogram, Gauge } from "prom-client";

export const successfulSubmissions = new Counter({
  name: "stellar_submissions_success_total",
  help: "Total number of successful Stellar price submissions",
  labelNames: ["asset"] as const,
});

export const failedSubmissions = new Counter({
  name: "stellar_submissions_failed_total",
  help: "Total number of failed Stellar price submissions",
  labelNames: ["asset", "reason"] as const,
});

export const gasUsagePerAsset = new Histogram({
  name: "stellar_gas_stroops",
  help: "Transaction fee in stroops per asset",
  labelNames: ["asset"] as const,
  buckets: [100, 500, 1000, 5000, 10000, 50000],
});

export const submissionDuration = new Histogram({
  name: "stellar_submission_duration_seconds",
  help: "Duration of Stellar submission operations in seconds",
  labelNames: ["asset"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
});

export const assetVolatility = new Gauge({
  name: "stellar_asset_volatility_24h",
  help: "24-hour rolling volatility index for an asset",
  labelNames: ["asset"] as const,
});
