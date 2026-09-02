import { Gauge } from "prom-client";
import { schedule, ScheduledTask } from "node-cron";
import prisma from "../lib/prisma";
import { register } from "../middleware/metrics";

const databaseSizeGauge = new Gauge({
  name: "postgresql_database_size_bytes",
  help: "Total on-disk size of the current PostgreSQL database, in bytes",
  registers: [register],
});

const tableSizeGauge = new Gauge({
  name: "postgresql_table_size_bytes",
  help: "On-disk size of each table (heap + TOAST + FSM/VM), in bytes",
  labelNames: ["table"] as const,
  registers: [register],
});

const indexSizeGauge = new Gauge({
  name: "postgresql_index_size_bytes",
  help: "Total size of all indexes attached to each table, in bytes",
  labelNames: ["table"] as const,
  registers: [register],
});

// Deliverable 3: Postgres has no built-in notion of "total disk size," so the
// ceiling is supplied out-of-band via env var, and checked against pg_database_size.
const CAPACITY_ALERT_THRESHOLD_RATIO = 0.8;

interface DatabaseSizeRow {
  size: bigint;
}

interface TableSizeRow {
  tablename: string;
  table_size: bigint;
  index_size: bigint;
}

export class StorageMonitorService {
  private task: ScheduledTask | null = null;
  private readonly maxCapacityBytes: number | null;

  constructor() {
    this.maxCapacityBytes = this.parseMaxCapacityBytes();
  }

  /** Starts the recurring collection job (every 15 minutes) and runs one pass immediately. */
  start(): void {
    if (this.task) {
      console.warn("[StorageMonitor] Service is already running");
      return;
    }

    if (this.maxCapacityBytes === null) {
      console.warn(
        "[StorageMonitor] DB_MAX_CAPACITY_BYTES is not set (or invalid) — " +
          "capacity alerting is disabled. Size/index metrics will still be collected.",
      );
    }

    void this.collectMetrics();

    this.task = schedule("*/15 * * * *", () => {
      void this.collectMetrics();
    });

    console.info("[StorageMonitor] Started with 15-minute collection interval");
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
    console.info("[StorageMonitor] Stopped");
  }

  private parseMaxCapacityBytes(): number | null {
    const raw = process.env.DB_MAX_CAPACITY_BYTES;
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.warn(
        `[StorageMonitor] DB_MAX_CAPACITY_BYTES="${raw}" is not a valid positive number — capacity alerting is disabled.`,
      );
      return null;
    }
    return parsed;
  }

  private async collectMetrics(): Promise<void> {
    try {
      const [dbSizeRows, tableSizeRows] = await Promise.all([
        prisma.$queryRaw<DatabaseSizeRow[]>`
          SELECT pg_database_size(current_database()) AS size
        `,
        prisma.$queryRaw<TableSizeRow[]>`
          SELECT
            tablename,
            pg_table_size(
              (quote_ident('public') || '.' || quote_ident(tablename))::regclass
            ) AS table_size,
            pg_indexes_size(
              (quote_ident('public') || '.' || quote_ident(tablename))::regclass
            ) AS index_size
          FROM pg_tables
          WHERE schemaname = 'public'
        `,
      ]);

      const dbSize = dbSizeRows[0]?.size;
      if (dbSize !== undefined) {
        const dbSizeBytes = Number(dbSize);
        databaseSizeGauge.set(dbSizeBytes);
        this.checkCapacity(dbSizeBytes);
      }

      for (const row of tableSizeRows) {
        tableSizeGauge.set({ table: row.tablename }, Number(row.table_size));
        indexSizeGauge.set({ table: row.tablename }, Number(row.index_size));
      }
    } catch (error) {
      console.error(
        "[StorageMonitor] Failed to collect PostgreSQL storage metrics:",
        error,
      );
    }
  }

  /**
   * Deliverable 3: trigger a high-priority warning when disk usage crosses 80%
   * of the configured capacity ceiling (DB_MAX_CAPACITY_BYTES).
   */
  private checkCapacity(dbSizeBytes: number): void {
    if (this.maxCapacityBytes === null) {
      return;
    }

    const ratio = dbSizeBytes / this.maxCapacityBytes;
    if (ratio >= CAPACITY_ALERT_THRESHOLD_RATIO) {
      const usedGb = (dbSizeBytes / 1e9).toFixed(2);
      const maxGb = (this.maxCapacityBytes / 1e9).toFixed(2);
      const percentUsed = (ratio * 100).toFixed(1);

      console.error(
        `🚨 [StorageMonitor] HIGH-PRIORITY CAPACITY WARNING: PostgreSQL database is at ${percentUsed}% ` +
          `of configured capacity (${usedGb} GB / ${maxGb} GB). Ops team should investigate before disk limits are hit.`,
      );
    }
  }
}

export const storageMonitorService = new StorageMonitorService();
