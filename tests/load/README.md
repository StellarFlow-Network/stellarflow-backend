# K6 Load Tests

Load testing scripts for the StellarFlow backend using [k6](https://k6.io).

## Prerequisites

Install k6:

```bash
# macOS
brew install k6

# Linux
sudo snap install k6

# Docker
docker pull grafana/k6
```

## Scripts

| Script | Purpose | Duration |
|--------|---------|----------|
| `smoke.js` | Sanity check — 1 VU, all endpoints | ~30s |
| `latest-prices.js` | 1,000 RPS sustained on `/api/v1/market-rates/latest` | 1m |
| `stress.js` | Ramp up past 1,000 RPS to find breaking point | ~8m |
| `soak.js` | 1,000 RPS for 30 minutes (memory/leak detection) | ~30m |

## Running

Always run the smoke test first to confirm the server is healthy:

```bash
k6 run tests/load/smoke.js
```

Main load test (1,000 RPS target):

```bash
k6 run tests/load/latest-prices.js
```

Against a non-local server, set `BASE_URL`:

```bash
k6 run -e BASE_URL=https://your-server.example.com tests/load/latest-prices.js
```

Stress test (find breaking point):

```bash
k6 run tests/load/stress.js
```

Soak test (sustained 30 minutes):

```bash
k6 run tests/load/soak.js
```

## Thresholds

The `latest-prices.js` script fails if:
- Error rate ≥ 1%
- p95 latency > 500ms
- p99 latency > 1,000ms

## Output

k6 prints a summary after each run. Key metrics to watch:

- `http_req_duration` — response time percentiles
- `http_req_failed` — error rate
- `http_reqs` — actual RPS achieved
- `request_latency` — custom latency trend

To export results as JSON:

```bash
k6 run --out json=results.json tests/load/latest-prices.js
```
