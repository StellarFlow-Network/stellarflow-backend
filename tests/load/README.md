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
| `pgbouncer-stress.js` | Compare high-concurrency reads through PgBouncer | ~7m |

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

PgBouncer comparison test:

```bash
k6 run -e BASE_URL=http://localhost:3000 tests/load/pgbouncer-stress.js
```

The Compose backend uses PgBouncer on port `6432` for runtime database
traffic. Compare this scenario with the same backend configured with
`DIRECT_DATABASE_URL` and record PostgreSQL CPU, `pg_stat_activity` connection
counts, and PgBouncer `SHOW POOLS` / `SHOW STATS` output. The comparison should
use the same host resources, dataset, request rate, and duration.

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

## Monitoring & Reporting

Run the resource monitor alongside any k6 scenario to capture CPU, memory,
event-loop lag, and database connection pool usage during the test, then
turn the results into a documented report:

```bash
mkdir -p tests/load/results

# terminal 1 — sample every 2s while the load test runs
DATABASE_URL=$DATABASE_URL node tests/load/monitor.js --out tests/load/results/peak-monitor.csv

# terminal 2 — run the peak scenario and export k6's summary
k6 run --summary-export tests/load/results/peak-summary.json -e API_KEY=$API_KEY tests/load/peak.js
# then stop the monitor (Ctrl+C) in terminal 1

# generate the bottleneck report
node tests/load/generate-report.js \
  --summary tests/load/results/peak-summary.json \
  --monitor tests/load/results/peak-monitor.csv \
  --out tests/load/results/peak-report.md
```

The report documents threshold pass/fail, request latency percentiles, and
peak resource utilization (memory, event-loop lag, DB connections) so
bottlenecks can be traced back to a specific component instead of just an
elevated p95.
