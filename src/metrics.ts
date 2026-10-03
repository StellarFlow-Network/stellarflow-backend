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

/**
 * Market stream (WebSocket) metrics.
 * Used by the combined high-frequency market data endpoint
 * (`wss://.../v1/market-stream?pairs=USDC-XLM,BTC-USDC`).
 */

export const marketStreamConnections = new Gauge({
  name: "market_stream_connections",
  help: "Number of currently active market-stream WebSocket connections",
  labelNames: ["protocol"] as const,
});

export const marketStreamConnectionsTotal = new Counter({
  name: "market_stream_connections_total",
  help: "Total number of market-stream WebSocket connections accepted",
  labelNames: ["protocol"] as const,
});

export const marketStreamDisconnectionsTotal = new Counter({
  name: "market_stream_disconnections_total",
  help: "Total number of market-stream WebSocket disconnections",
  labelNames: ["protocol", "reason"] as const,
});

export const marketStreamMemoryBytes = new Gauge({
  name: "market_stream_connection_memory_bytes",
  help: "Estimated memory overhead in bytes per market-stream connection",
  labelNames: ["protocol"] as const,
});

export const marketStreamTotalMemoryBytes = new Gauge({
  name: "market_stream_total_memory_bytes",
  help: "Estimated total memory overhead in bytes for all market-stream connections",
  labelNames: ["protocol"] as const,
});

export const marketStreamMessagesTotal = new Counter({
  name: "market_stream_messages_total",
  help: "Total number of market-stream messages sent to clients",
  labelNames: ["protocol", "kind"] as const,
});

export const marketStreamBytesTotal = new Counter({
  name: "market_stream_bytes_total",
  help: "Total number of bytes sent over market-stream connections",
  labelNames: ["protocol"] as const,
});

export const marketStreamFanoutDuration = new Histogram({
  name: "market_stream_fanout_duration_seconds",
  help: "Duration of fanouting a market update to all subscribed clients in seconds",
  labelNames: ["kind"] as const,
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
});
