/**
 * PgBouncer comparison stress test.
 *
 * Run against a backend configured with PgBouncer:
 *   k6 run -e BASE_URL=http://localhost:3000 tests/load/pgbouncer-stress.js
 *
 * Run the same scenario against a direct PostgreSQL-backed backend and compare
 * the k6 summary with PostgreSQL and PgBouncer connection statistics.
 */
import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";

const errors = new Rate("pgbouncer_error_rate");
const latency = new Trend("pgbouncer_request_latency", true);
const baseUrl = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  scenarios: {
    high_concurrency_reads: {
      executor: "ramping-arrival-rate",
      startRate: 100,
      timeUnit: "1s",
      preAllocatedVUs: 250,
      maxVUs: 2000,
      stages: [
        { duration: "1m", target: 500 },
        { duration: "2m", target: 1000 },
        { duration: "3m", target: 2000 },
        { duration: "1m", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<2000", "p(99)<5000"],
    pgbouncer_error_rate: ["rate<0.05"],
  },
};

export default function () {
  const response = http.get(`${baseUrl}/api/v1/market-rates/latest`, {
    tags: { scenario: "pgbouncer-high-concurrency" },
    timeout: "15s",
  });

  const ok = check(response, {
    "status is successful": (res) => res.status >= 200 && res.status < 500,
    "not a server error": (res) => res.status < 500,
  });

  errors.add(!ok);
  latency.add(response.timings.duration);
}
