/**
 * Weekly Query Performance Summary Report Generator
 * Issue #1014 – PostgreSQL Query Execution Time Tracker and Slow Query Logger
 *
 * This job generates weekly reports summarizing database query performance,
 * including slow query statistics and recommendations for optimization.
 */

import { logger } from "../config/logger";
import { dbSlowQueriesTotal, dbQueryDuration, dbQueriesTotal } from "../metrics/queryMetrics";
import { register } from "prom-client";

interface QueryPerformanceSummary {
  weekStart: string;
  weekEnd: string;
  totalQueries: number;
  slowQueries: number;
  slowQueryRate: number;
  avgQueryDuration: number;
  p50QueryDuration: number;
  p95QueryDuration: number;
  p99QueryDuration: number;
  topSlowModels: Array<{
    model: string;
    slowQueryCount: number;
    totalQueryCount: number;
    slowQueryRate: number;
  }>;
  topSlowOperations: Array<{
    operation: string;
    slowQueryCount: number;
    totalQueryCount: number;
    slowQueryRate: number;
  }>;
}

/**
 * Generate a weekly query performance summary report
 */
export async function generateWeeklyQueryPerformanceReport(): Promise<QueryPerformanceSummary> {
  try {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 7);
    const weekEnd = now;

    logger.info(
      `[Query Performance Report] Generating report for ${weekStart.toISOString()} to ${weekEnd.toISOString()}`,
    );

    // Get metrics from Prometheus registry
    const metrics = await register.getMetricsAsJSON();

    // Extract query metrics
    const slowQueriesMetric = metrics.find((m) => m.name === "db_slow_queries_total");
    const queryDurationMetric = metrics.find((m) => m.name === "db_query_duration_milliseconds");
    const totalQueriesMetric = metrics.find((m) => m.name === "db_queries_total");

    // Calculate total queries
    let totalQueries = 0;
    if (totalQueriesMetric) {
      totalQueriesMetric.values.forEach((value) => {
        totalQueries += value.value;
      });
    }

    // Calculate slow queries
    let slowQueries = 0;
    const modelSlowCounts: Record<string, number> = {};
    const operationSlowCounts: Record<string, number> = {};
    const modelTotalCounts: Record<string, number> = {};
    const operationTotalCounts: Record<string, number> = {};

    if (slowQueriesMetric) {
      slowQueriesMetric.values.forEach((value) => {
        slowQueries += value.value;
        const model = value.labels.model || "unknown";
        const operation = value.labels.operation || "unknown";

        modelSlowCounts[model] = (modelSlowCounts[model] || 0) + value.value;
        operationSlowCounts[operation] =
          (operationSlowCounts[operation] || 0) + value.value;
      });
    }

    if (totalQueriesMetric) {
      totalQueriesMetric.values.forEach((value) => {
        const model = value.labels.model || "unknown";
        const operation = value.labels.operation || "unknown";

        modelTotalCounts[model] = (modelTotalCounts[model] || 0) + value.value;
        operationTotalCounts[operation] =
          (operationTotalCounts[operation] || 0) + value.value;
      });
    }

    // Calculate duration percentiles (simplified - in production use histogram data)
    let avgQueryDuration = 0;
    let p50QueryDuration = 0;
    let p95QueryDuration = 0;
    let p99QueryDuration = 0;

    if (queryDurationMetric) {
      const sum = queryDurationMetric.values.reduce((acc, val) => acc + val.value, 0);
      const count = queryDurationMetric.values.length;
      avgQueryDuration = count > 0 ? sum / count : 0;

      // For percentiles, we'd need histogram bucket data
      // Using simplified estimates based on bucket boundaries
      const buckets = queryDurationMetric.values
        .filter((v) => v.labels.le !== undefined)
        .map((v) => ({
          le: parseFloat(v.labels.le),
          count: v.value,
        }))
        .sort((a, b) => a.le - b.le);

      if (buckets.length > 0) {
        const totalCount = buckets[buckets.length - 1].count;
        p50QueryDuration = estimatePercentile(buckets, totalCount, 0.5);
        p95QueryDuration = estimatePercentile(buckets, totalCount, 0.95);
        p99QueryDuration = estimatePercentile(buckets, totalCount, 0.99);
      }
    }

    // Calculate top slow models
    const topSlowModels = Object.entries(modelSlowCounts)
      .map(([model, slowCount]) => ({
        model,
        slowQueryCount: slowCount,
        totalQueryCount: modelTotalCounts[model] || 0,
        slowQueryRate:
          (modelTotalCounts[model] || 0) > 0
            ? (slowCount / modelTotalCounts[model]) * 100
            : 0,
      }))
      .sort((a, b) => b.slowQueryCount - a.slowQueryCount)
      .slice(0, 10);

    // Calculate top slow operations
    const topSlowOperations = Object.entries(operationSlowCounts)
      .map(([operation, slowCount]) => ({
        operation,
        slowQueryCount: slowCount,
        totalQueryCount: operationTotalCounts[operation] || 0,
        slowQueryRate:
          (operationTotalCounts[operation] || 0) > 0
            ? (slowCount / operationTotalCounts[operation]) * 100
            : 0,
      }))
      .sort((a, b) => b.slowQueryCount - a.slowQueryCount)
      .slice(0, 10);

    const summary: QueryPerformanceSummary = {
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      totalQueries,
      slowQueries,
      slowQueryRate: totalQueries > 0 ? (slowQueries / totalQueries) * 100 : 0,
      avgQueryDuration,
      p50QueryDuration,
      p95QueryDuration,
      p99QueryDuration,
      topSlowModels,
      topSlowOperations,
    };

    logger.info(
      `[Query Performance Report] Report generated: ${JSON.stringify(summary, null, 2)}`,
    );

    return summary;
  } catch (error) {
    logger.error("[Query Performance Report] Failed to generate report:", error);
    throw error;
  }
}

/**
 * Estimate percentile from histogram buckets
 */
function estimatePercentile(
  buckets: Array<{ le: number; count: number }>,
  totalCount: number,
  percentile: number,
): number {
  const targetCount = totalCount * percentile;
  for (const bucket of buckets) {
    if (bucket.count >= targetCount) {
      return bucket.le;
    }
  }
  return buckets[buckets.length - 1]?.le || 0;
}

/**
 * Format the summary report as a human-readable string
 */
export function formatQueryPerformanceReport(
  summary: QueryPerformanceSummary,
): string {
  const lines = [
    "=== Weekly Query Performance Summary ===",
    `Period: ${summary.weekStart} to ${summary.weekEnd}`,
    "",
    "Overall Statistics:",
    `  Total Queries: ${summary.totalQueries}`,
    `  Slow Queries (>100ms): ${summary.slowQueries}`,
    `  Slow Query Rate: ${summary.slowQueryRate.toFixed(2)}%`,
    "",
    "Query Duration (ms):",
    `  Average: ${summary.avgQueryDuration.toFixed(2)}`,
    `  P50: ${summary.p50QueryDuration.toFixed(2)}`,
    `  P95: ${summary.p95QueryDuration.toFixed(2)}`,
    `  P99: ${summary.p99QueryDuration.toFixed(2)}`,
    "",
    "Top 10 Slowest Models:",
    ...summary.topSlowModels.map(
      (m, i) =>
        `  ${i + 1}. ${m.model}: ${m.slowQueryCount} slow queries (${m.slowQueryRate.toFixed(2)}% of ${m.totalQueryCount} total)`,
    ),
    "",
    "Top 10 Slowest Operations:",
    ...summary.topSlowOperations.map(
      (o, i) =>
        `  ${i + 1}. ${o.operation}: ${o.slowQueryCount} slow queries (${o.slowQueryRate.toFixed(2)}% of ${o.totalQueryCount} total)`,
    ),
    "",
    "========================================",
  ];

  return lines.join("\n");
}
