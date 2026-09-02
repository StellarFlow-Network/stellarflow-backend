/**
 * Peak load test — ramps to the 10,000 req/sec target across core API
 * routes (not just market-rates) to validate stability under simulated
 * peak traffic per the load-testing harness requirements.
 *
 * Protected routes (everything under /api/v1 except /auth) require an
 * API key. Pass one via -e API_KEY=... or the requests will 401, which
 * still exercises rate-limit/auth-middleware overhead under load.
 *
 * Usage: k6 run tests/load/peak.js
 *        k6 run -e BASE_URL=https://staging.example.com -e API_KEY=xxx tests/load/peak.js
 */
import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("error_rate");
const latency = new Trend("request_latency", true);

export const options = {
  scenarios: {
    peak_ramp: {
      executor: "ramping-arrival-rate",
      startRate: 500,
      timeUnit: "1s",
      preAllocatedVUs: 500,
      maxVUs: 4000,
      stages: [
        { duration: "1m", target: 2500 },   // 25% of target
        { duration: "1m", target: 5000 },   // 50% of target
        { duration: "2m", target: 10000 },  // 10,000 req/sec (peak target)
        { duration: "3m", target: 10000 },  // hold at peak
        { duration: "1m", target: 0 },      // ramp down
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2000"],
    error_rate: ["rate<0.05"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY || "";

const headers = {
  "Content-Type": "application/json",
  ...(API_KEY ? { "x-api-key": API_KEY } : {}),
};

// A representative mix of core, read-heavy API routes rather than a
// single endpoint, weighted toward the hottest path (market rates).
const ROUTES = [
  `${BASE_URL}/api/v1/market-rates/latest`,
  `${BASE_URL}/api/v1/market-rates/latest`,
  `${BASE_URL}/api/v1/market-rates/latest`,
  `${BASE_URL}/api/v1/status`,
  `${BASE_URL}/api/v1/stats/relayers`,
  `${BASE_URL}/api/v1/assets`,
  `${BASE_URL}/api/v1/orders/depth`,
  `${BASE_URL}/api/v1/remittance/history`,
];

export default function () {
  const url = ROUTES[Math.floor(Math.random() * ROUTES.length)];
  const res = http.get(url, { headers, timeout: "15s" });

  const success = check(res, {
    "no server error": (r) => r.status < 500,
  });

  errorRate.add(!success);
  latency.add(res.timings.duration);
}
