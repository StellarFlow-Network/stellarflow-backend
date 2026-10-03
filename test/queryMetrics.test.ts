/**
 * Test file for query performance metrics
 * Issue #1014 – PostgreSQL Query Execution Time Tracker and Slow Query Logger
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  dbSlowQueriesTotal,
  dbQueryDuration,
  dbQueriesTotal,
} from "../src/metrics/queryMetrics";
import { register } from "prom-client";

describe("Query Performance Metrics", () => {
  beforeEach(() => {
    // Clear all metrics before each test
    register.clear();
  });

  it("should increment dbSlowQueriesTotal counter", () => {
    const initialCount = dbSlowQueriesTotal
      .get()
      .values.find((v) => v.labels.model === "TestModel" && v.labels.operation === "findMany")
      ?.value || 0;

    dbSlowQueriesTotal.inc({ model: "TestModel", operation: "findMany" });

    const newCount = dbSlowQueriesTotal
      .get()
      .values.find((v) => v.labels.model === "TestModel" && v.labels.operation === "findMany")
      ?.value || 0;

    expect(newCount).toBe(initialCount + 1);
  });

  it("should observe dbQueryDuration histogram", () => {
    dbQueryDuration.observe({ model: "TestModel", operation: "findMany" }, 150);

    const metric = dbQueryDuration.get();
    expect(metric.name).toBe("db_query_duration_milliseconds");
    expect(metric.values.length).toBeGreaterThan(0);
  });

  it("should increment dbQueriesTotal counter", () => {
    const initialCount = dbQueriesTotal
      .get()
      .values.find((v) => v.labels.model === "TestModel" && v.labels.operation === "findMany")
      ?.value || 0;

    dbQueriesTotal.inc({ model: "TestModel", operation: "findMany" });

    const newCount = dbQueriesTotal
      .get()
      .values.find((v) => v.labels.model === "TestModel" && v.labels.operation === "findMany")
      ?.value || 0;

    expect(newCount).toBe(initialCount + 1);
  });

  it("should have correct metric names", () => {
    expect(dbSlowQueriesTotal.name).toBe("db_slow_queries_total");
    expect(dbQueryDuration.name).toBe("db_query_duration_milliseconds");
    expect(dbQueriesTotal.name).toBe("db_queries_total");
  });

  it("should have correct label names", () => {
    expect(dbSlowQueriesTotal.labelNames).toEqual(["model", "operation"]);
    expect(dbQueryDuration.labelNames).toEqual(["model", "operation"]);
    expect(dbQueriesTotal.labelNames).toEqual(["model", "operation"]);
  });
});
