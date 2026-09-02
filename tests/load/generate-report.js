/**
 * Generates a markdown bottleneck report from a k6 JSON summary and an
 * optional monitor.js CSV, so stress-test results are documented rather
 * than just printed to a terminal.
 *
 * Usage:
 *   k6 run --summary-export tests/load/results/peak-summary.json tests/load/peak.js
 *   node tests/load/monitor.js --out tests/load/results/peak-monitor.csv &
 *   node tests/load/generate-report.js \
 *     --summary tests/load/results/peak-summary.json \
 *     --monitor tests/load/results/peak-monitor.csv \
 *     --out tests/load/results/peak-report.md
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const summaryPath = arg("summary");
const monitorPath = arg("monitor");
const outPath = arg("out", "tests/load/results/report.md");

if (!summaryPath) {
  console.error(
    "Usage: node tests/load/generate-report.js --summary <k6-summary.json> [--monitor <monitor.csv>] [--out <report.md>]",
  );
  process.exit(1);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const metrics = summary.metrics || {};

function metricLine(name, metric, unit = "") {
  if (!metric) return null;
  const parts = [];
  if (metric.avg != null) parts.push(`avg ${metric.avg.toFixed(2)}${unit}`);
  if (metric["p(95)"] != null) parts.push(`p95 ${metric["p(95)"].toFixed(2)}${unit}`);
  if (metric["p(99)"] != null) parts.push(`p99 ${metric["p(99)"].toFixed(2)}${unit}`);
  if (metric.max != null) parts.push(`max ${metric.max.toFixed(2)}${unit}`);
  if (metric.rate != null) parts.push(`rate ${(metric.rate * 100).toFixed(2)}%`);
  if (metric.count != null) parts.push(`count ${metric.count}`);
  return `- **${name}**: ${parts.join(", ")}`;
}

const lines = [];
lines.push(`# Load Test Report`);
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Source: \`${summaryPath}\``);
lines.push("");
lines.push(`## Key Metrics`);
lines.push("");
[
  metricLine("HTTP request duration", metrics.http_req_duration, "ms"),
  metricLine("HTTP request failed", metrics.http_req_failed),
  metricLine("Requests/sec", metrics.http_reqs),
  metricLine("Error rate (custom)", metrics.error_rate),
  metricLine("Request latency (custom)", metrics.request_latency, "ms"),
]
  .filter(Boolean)
  .forEach((l) => lines.push(l));

lines.push("");
lines.push(`## Thresholds`);
lines.push("");
const breached = [];
for (const [name, m] of Object.entries(metrics)) {
  if (!m.thresholds) continue;
  for (const [expr, result] of Object.entries(m.thresholds)) {
    const ok = result.ok !== false;
    lines.push(`- ${ok ? "PASS" : "FAIL"}: \`${name}\` ${expr}`);
    if (!ok) breached.push(`${name} ${expr}`);
  }
}
if (Object.values(metrics).every((m) => !m.thresholds)) {
  lines.push("- No thresholds recorded in this summary.");
}

lines.push("");
lines.push(`## Resource Utilization`);
lines.push("");
if (monitorPath) {
  try {
    const csv = readFileSync(monitorPath, "utf8").trim().split("\n");
    const header = csv[0].split(",");
    const rows = csv.slice(1).map((line) => line.split(","));
    const colIdx = (name) => header.indexOf(name);

    const maxOf = (col) => {
      const idx = colIdx(col);
      if (idx === -1) return null;
      const values = rows.map((r) => Number(r[idx])).filter((v) => !Number.isNaN(v));
      return values.length ? Math.max(...values) : null;
    };

    const maxMem = maxOf("process_resident_memory_mb");
    const maxHeap = maxOf("nodejs_heap_used_mb");
    const maxLag = maxOf("nodejs_eventloop_lag_ms");
    const maxDbActive = maxOf("db_active_connections");
    const maxDbTotal = maxOf("db_total_connections");

    if (maxMem != null) lines.push(`- Peak resident memory: ${maxMem.toFixed(1)} MB`);
    if (maxHeap != null) lines.push(`- Peak heap used: ${maxHeap.toFixed(1)} MB`);
    if (maxLag != null) lines.push(`- Peak event-loop lag: ${maxLag.toFixed(1)} ms`);
    if (maxDbActive != null) lines.push(`- Peak active DB connections: ${maxDbActive}`);
    if (maxDbTotal != null) lines.push(`- Peak total DB connections: ${maxDbTotal}`);
    lines.push(`- Samples: ${rows.length} (source: \`${monitorPath}\`)`);
  } catch (err) {
    lines.push(`- Could not read monitor CSV (${monitorPath}): ${err.message}`);
  }
} else {
  lines.push("- No monitor CSV provided (run tests/load/monitor.js alongside k6 to capture this).");
}

lines.push("");
lines.push(`## Bottlenecks Identified`);
lines.push("");
if (breached.length) {
  breached.forEach((b) => lines.push(`- Threshold breached: ${b} — investigate the corresponding component (see Resource Utilization above for correlated CPU/memory/DB pool pressure at the same time window).`));
} else {
  lines.push("- No threshold breaches recorded. Re-run at a higher target rate to find the actual breaking point (see `tests/load/stress.js` / `peak.js`).");
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`Report written to ${outPath}`);
