/**
 * Smoke test — run this first to confirm the server is up and endpoints
 * respond correctly before running heavier load tests.
 *
 * Usage: k6 run tests/load/smoke.js
 */
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 1,
  duration: "30s",
  thresholds: {
    http_req_failed: ["rate==0"],
    http_req_duration: ["p(95)<1000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

const ENDPOINTS = [
  { name: "latest prices", url: `${BASE_URL}/api/v1/market-rates/latest` },
  { name: "all rates", url: `${BASE_URL}/api/v1/market-rates/rates` },
  { name: "status", url: `${BASE_URL}/api/v1/status` },
  { name: "NGN rate", url: `${BASE_URL}/api/v1/market-rates/rate/NGN` },
  { name: "GHS rate", url: `${BASE_URL}/api/v1/market-rates/rate/GHS` },
  { name: "KES rate", url: `${BASE_URL}/api/v1/market-rates/rate/KES` },
];

export default function () {
  for (const endpoint of ENDPOINTS) {
    const res = http.get(endpoint.url, { timeout: "10s" });

    check(res, {
      [`${endpoint.name}: status 200`]: (r) => r.status === 200,
      [`${endpoint.name}: has body`]: (r) => r.body && r.body.length > 0,
    });

    sleep(0.5);
  }
}
