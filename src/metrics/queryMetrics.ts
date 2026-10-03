/**
 * Prometheus metrics for database query performance tracking.
 * Issue #1014 – PostgreSQL Query Execution Time Tracker and Slow Query Logger
 */
import { Counter, Histogram } from "prom-client";

/**
 * Counter for total number of slow database queries.
 * Labels: model (e.g., "PriceHistory", "Relayer"), operation (e.g., "findMany", "create")
 */
export const dbSlowQueriesTotal = new Counter({
  name: "db_slow_queries_total",
  help: "Total number of slow database queries exceeding the threshold",
  labelNames: ["model", "operation"] as const,
});

/**
 * Histogram for database query execution time in milliseconds.
 * Labels: model, operation
 * Buckets: 1ms, 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s
 */
export const dbQueryDuration = new Histogram({
  name: "db_query_duration_milliseconds",
  help: "Database query execution time in milliseconds",
  labelNames: ["model", "operation"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

/**
 * Counter for total number of database queries by model and operation.
 */
export const dbQueriesTotal = new Counter({
  name: "db_queries_total",
  help: "Total number of database queries executed",
  labelNames: ["model", "operation"] as const,
});
