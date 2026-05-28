'use strict';

const client = require('prom-client');

// Create a dedicated registry so we don't bleed into any default register
const registry = new client.Registry();

// ── Default Node.js process metrics (CPU, memory, event loop lag) ──────────
client.collectDefaultMetrics({ register: registry, prefix: 'stellarflow_' });

// ── Custom oracle metrics ───────────────────────────────────────────────────

/**
 * successful_submissions_total
 * Counter — incremented each time an oracle round is submitted successfully.
 * Label: asset  (e.g. "XLM/USD", "BTC/USD")
 */
const successfulSubmissions = new client.Counter({
  name: 'oracle_successful_submissions_total',
  help: 'Total number of successful oracle price submissions',
  labelNames: ['asset'],
  registers: [registry],
});

/**
 * failed_submissions_total
 * Counter — incremented on any submission error (RPC error, timeout, etc.).
 * Label: asset, reason  (e.g. reason="timeout" | "rpc_error" | "validation")
 */
const failedSubmissions = new client.Counter({
  name: 'oracle_failed_submissions_total',
  help: 'Total number of failed oracle price submissions',
  labelNames: ['asset', 'reason'],
  registers: [registry],
});

/**
 * gas_usage_per_asset
 * Histogram — records the fee/stroops used per submission so Grafana can
 * show p50/p95/p99 percentiles per asset.
 * Buckets are tuned for Stellar stroops (1 XLM = 10_000_000 stroops).
 */
const gasUsagePerAsset = new client.Histogram({
  name: 'oracle_gas_usage_per_asset',
  help: 'Stellar transaction fee (in stroops) used per oracle submission',
  labelNames: ['asset'],
  buckets: [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
  registers: [registry],
});

/**
 * submission_duration_seconds
 * Histogram — end-to-end latency of a submission from signing to ledger confirm.
 */
const submissionDuration = new client.Histogram({
  name: 'oracle_submission_duration_seconds',
  help: 'End-to-end duration of an oracle submission in seconds',
  labelNames: ['asset'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

module.exports = {
  registry,
  successfulSubmissions,
  failedSubmissions,
  gasUsagePerAsset,
  submissionDuration,
};
