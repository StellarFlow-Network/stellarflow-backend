/**
 * Soak test — runs the 1,000 RPS target for an extended period to detect
 * memory leaks, connection pool exhaustion, and database degradation.
 *
 * Usage: k6 run tests/load/soak.js
 * Note:  Expect this to run for ~35 minutes.
 */
import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("error_rate");
const latency = new Trend("request_latency", true);

export const options = {
  scenarios: {
    soak: {
      executor: "constant-arrival-rate",
      rate: 1000,
      timeUnit: "1s",
      duration: "30m",
      preAllocatedVUs: 200,
      maxVUs: 500,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
    // latency must not degrade over time — keep p99 under 1s throughout
    http_req_duration: ["p(99)<1000"],
    error_rate: ["rate<0.01"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const res = http.get(`${BASE_URL}/api/v1/market-rates/latest`, {
    headers: { "Content-Type": "application/json" },
    timeout: "10s",
  });

  const success = check(res, {
    "status 200": (r) => r.status === 200,
    "response time < 500ms": (r) => r.timings.duration < 500,
  });

  errorRate.add(!success);
  latency.add(res.timings.duration);
}
