'use strict';

const express = require('express');
const { registry } = require('./oracleMetrics');

const router = express.Router();

/**
 * Bearer-token middleware
 * Reads METRICS_SECRET from env. Rejects with 401 if missing or wrong.
 * Returns 403 if the env var itself is not configured (fail-safe).
 */
function requireMetricsToken(req, res, next) {
  const secret = process.env.METRICS_SECRET;

  if (!secret) {
    console.error('[metrics] METRICS_SECRET env var is not set — endpoint disabled');
    return res.status(403).json({ error: 'Metrics endpoint is not configured' });
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token || token !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

/**
 * GET /metrics
 * Returns Prometheus text exposition format.
 * Protected by Bearer token (see requireMetricsToken above).
 *
 * Grafana scrape config example:
 *   - job_name: stellarflow-oracle
 *     bearer_token: <your-secret>
 *     static_configs:
 *       - targets: ['your-host:3000']
 *     metrics_path: /metrics
 */
router.get('/', requireMetricsToken, async (req, res) => {
  try {
    res.set('Content-Type', registry.contentType);
    const output = await registry.metrics();
    res.end(output);
  } catch (err) {
    console.error('[metrics] Failed to collect metrics:', err);
    res.status(500).end();
  }
});

module.exports = router;
