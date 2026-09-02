/**
 * Resource monitor for load/stress test runs.
 *
 * Samples the app's /metrics endpoint (process CPU, memory, event-loop
 * lag — via prom-client's collectDefaultMetrics) and the Postgres
 * database (active connections / pool saturation) at a fixed interval,
 * and writes the samples to a CSV for later analysis or inclusion in a
 * bottleneck report.
 *
 * Run this alongside a k6 scenario, e.g.:
 *   node tests/load/monitor.js --out tests/load/results/peak-monitor.csv &
 *   k6 run tests/load/peak.js
 *   kill %1
 *
 * Env vars:
 *   BASE_URL       app base URL (default http://localhost:3000)
 *   DATABASE_URL   Postgres connection string (default: process env, same as the app)
 *   INTERVAL_MS    sample interval in ms (default 2000)
 */
import { Client } from "pg";
import { writeFileSync, appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const DATABASE_URL = process.env.DATABASE_URL;
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 2000);

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT_FILE =
  outIdx !== -1 && args[outIdx + 1]
    ? args[outIdx + 1]
    : `tests/load/results/monitor-${Date.now()}.csv`;

const HEADER =
  "timestamp,process_cpu_seconds_total,process_resident_memory_mb,nodejs_heap_used_mb,nodejs_eventloop_lag_ms,db_active_connections,db_idle_connections,db_total_connections,http_p_error\n";

function parsePromMetric(text, name) {
  const re = new RegExp(`^${name}(\\{[^}]*\\})?\\s+([0-9eE+\\-.]+)`, "m");
  const match = text.match(re);
  return match ? Number(match[2]) : null;
}

async function sampleApp() {
  try {
    const res = await fetch(`${BASE_URL}/metrics`);
    if (!res.ok) return {};
    const text = await res.text();

    const cpuUser = parsePromMetric(text, "process_cpu_user_seconds_total") || 0;
    const cpuSys = parsePromMetric(text, "process_cpu_system_seconds_total") || 0;
    const residentBytes = parsePromMetric(text, "process_resident_memory_bytes");
    const heapUsedBytes = parsePromMetric(text, "nodejs_heap_size_used_bytes");
    const lagSeconds = parsePromMetric(text, "nodejs_eventloop_lag_seconds");

    return {
      process_cpu_seconds_total: cpuUser + cpuSys,
      process_resident_memory_mb: residentBytes ? residentBytes / 1024 / 1024 : "",
      nodejs_heap_used_mb: heapUsedBytes ? heapUsedBytes / 1024 / 1024 : "",
      nodejs_eventloop_lag_ms: lagSeconds != null ? lagSeconds * 1000 : "",
    };
  } catch {
    return {};
  }
}

async function sampleDb(client) {
  if (!client) return {};
  try {
    const { rows } = await client.query(
      `select state, count(*)::int as count
       from pg_stat_activity
       where datname = current_database()
       group by state`,
    );
    let active = 0;
    let idle = 0;
    let total = 0;
    for (const row of rows) {
      total += row.count;
      if (row.state === "active") active += row.count;
      else if (row.state && row.state.startsWith("idle")) idle += row.count;
    }
    return {
      db_active_connections: active,
      db_idle_connections: idle,
      db_total_connections: total,
    };
  } catch {
    return {};
  }
}

async function main() {
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, HEADER);

  let dbClient = null;
  if (DATABASE_URL) {
    dbClient = new Client({ connectionString: DATABASE_URL });
    try {
      await dbClient.connect();
    } catch (err) {
      console.error(`[monitor] could not connect to DATABASE_URL: ${err.message}`);
      dbClient = null;
    }
  } else {
    console.warn("[monitor] DATABASE_URL not set — skipping DB pool sampling");
  }

  console.log(`[monitor] sampling ${BASE_URL} every ${INTERVAL_MS}ms -> ${OUT_FILE}`);
  console.log("[monitor] press Ctrl+C to stop");

  const tick = async () => {
    const [app, db] = await Promise.all([sampleApp(), sampleDb(dbClient)]);
    const row = [
      new Date().toISOString(),
      app.process_cpu_seconds_total ?? "",
      app.process_resident_memory_mb ?? "",
      app.nodejs_heap_used_mb ?? "",
      app.nodejs_eventloop_lag_ms ?? "",
      db.db_active_connections ?? "",
      db.db_idle_connections ?? "",
      db.db_total_connections ?? "",
      "",
    ].join(",");
    appendFileSync(OUT_FILE, row + "\n");
  };

  const interval = setInterval(tick, INTERVAL_MS);
  await tick();

  const shutdown = async () => {
    clearInterval(interval);
    if (dbClient) await dbClient.end().catch(() => {});
    console.log(`[monitor] stopped, samples written to ${OUT_FILE}`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
