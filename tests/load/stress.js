/**
 * Stress test — ramps up past the 1,000 RPS target to find the
 * breaking point and observe how the server degrades.
 *
 * Usage: k6 run tests/load/stress.js
 */
import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("error_rate");
const latency = new Trend("request_latency", true);

export const options = {
  scenarios: {
    stress_ramp: {
      executor: "ramping-arrival-rate",
      startRate: 100,
      timeUnit: "1s",
      preAllocatedVUs: 200,
      maxVUs: 1000,
      stages: [
        { duration: "1m", target: 500 },   // ramp to 500 RPS
        { duration: "2m", target: 1000 },  // ramp to 1,000 RPS (target)
        { duration: "2m", target: 1500 },  // push to 1,500 RPS
        { duration: "2m", target: 2000 },  // push to 2,000 RPS
        { duration: "1m", target: 0 },     // ramp down
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],      // allow up to 5% errors under stress
    http_req_duration: ["p(95)<2000"],   // 95% under 2s under stress
    error_rate: ["rate<0.05"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const res = http.get(`${BASE_URL}/api/v1/market-rates/latest`, {
    headers: { "Content-Type": "application/json" },
    timeout: "15s",
  });

  const success = check(res, {
    "status 200": (r) => r.status === 200,
    "no server error": (r) => r.status < 500,
  });

  errorRate.add(!success);
  latency.add(res.timings.duration);
}
