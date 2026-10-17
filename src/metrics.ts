/*
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
 * Flasb loan circuit breaker metrics.
 * Used by the emergency bot that monitors the mempool for malicious
 * flasb loan patterns and triggers automatic contract pauses.
 */

export const flashLoanSuspiciousTotal = new Counter({
  name: "flash_loan_suspicious_total",
  help: "Total number of suspicious flash loan transactions detected in the mempool",
  labelNames: ["pool"] as const,
});

export const flashLoanAnomaliesTotal = new Counter({
  name: "flash_loan_anomalies_total",
  help: "Total number of flash loan anomalies that exceeded the per-ledger threshold",
  labelNames: ["pool"] as const,
});

export const circuitBreakerPausesTotal = new Counter({
  name: "circuit_breaker_pauses_total",
  help: "Total number of emergency contract pause calls submitted",
  labelNames: ["pool", "status"] as const,
});

export const circuitBreakerPauseDuration = new Histogram({
  name: "circuit_breaker_pause_duration_seconds",
  help: "Duration of emergency contract pause submissions in seconds",
  labelNames: ["pool"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

export const circuitBreakerAlertsTotal = new Counter({
  name: "circuit_breaker_alerts_total",
  help: "Total number of emergency security alerts dispatched to Telegram",
  labelNames: ["status"] as const,
});

export const flashLoanLedgerSuspicion = new Gauge({
  name: "flash_loan_ledger_suspicion",
  help: "Number of suspicious flash loans observed in the current ledger window",
  labelNames: ["pool"] as const,
});

/**
 * Market stream (WebSocket) metrics.
 * Used by the combined high-frequency market data endpoint
 * (`wss://.../v1/market-stream?pairs=USD-XLM,BTC-US@).
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
