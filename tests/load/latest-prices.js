import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

const errorRate = new Rate("error_rate");
const latency = new Trend("request_latency", true);
const requestCount = new Counter("request_count");

// Target: 1,000 requests per second sustained for 1 minute
export const options = {
  scenarios: {
    latest_prices_load: {
      executor: "constant-arrival-rate",
      rate: 1000,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 200,
      maxVUs: 500,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],       // <1% error rate
    http_req_duration: ["p(95)<500"],     // 95% of requests under 500ms
    http_req_duration: ["p(99)<1000"],    // 99% of requests under 1s
    error_rate: ["rate<0.01"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const url = `${BASE_URL}/api/v1/market-rates/latest`;

  const res = http.get(url, {
    headers: { "Content-Type": "application/json" },
    timeout: "10s",
  });

  const success = check(res, {
    "status is 200": (r) => r.status === 200,
    "response has success field": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success === true;
      } catch {
        return false;
      }
    },
    "response has data field": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.data !== undefined;
      } catch {
        return false;
      }
    },
    "response time < 500ms": (r) => r.timings.duration < 500,
  });

  errorRate.add(!success);
  latency.add(res.timings.duration);
  requestCount.add(1);
}
