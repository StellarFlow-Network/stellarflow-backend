import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ParquetSchema, ParquetWriter } from "parquetjs-lite";
import { createReadStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger";
import type { OrderBookSnapshot } from "./orderBookSnapshotEngine";

export type OrderBookDepthSide = "bid" | "ask";

export interface OrderBookDepthExportRow {
  ledger_seq: number;
  captured_at: string;
  side: OrderBookDepthSide;
  level_index: number;
  price: number;
  amount: number;
}

export interface OrderBookDepthSnapshotExporterConfig {
  enabled: boolean;
  exportIntervalLedgers: number;
  topLevelsPerSide: number;
  bucketName: string;
  s3Prefix: string;
  awsRegion: string;
  s3Client?: { send: (command: unknown) => Promise<unknown> };
}

export interface OrderBookDepthExportResult {
  bucket: string;
  key: string;
  ledgerSeq: number;
  rowsWritten: number;
  exportedAt: string;
}

export interface OrderBookDepthSchemaValidation {
  valid: boolean;
  requiredFields: string[];
  missingColumns: string[];
  invalidRowCount: number;
  rowCount: number;
}

export interface OrderBookDepthHealthReport {
  ok: boolean;
  checkedAt: string;
  requiredFields: string[];
  rowCount: number;
  valid: boolean;
  skipped?: boolean;
}

const DEFAULT_CONFIG: OrderBookDepthSnapshotExporterConfig = {
  enabled: true,
  exportIntervalLedgers: 10,
  topLevelsPerSide: 50,
  bucketName: "stellarflow-analytics-orderbook",
  s3Prefix: "orderbook-depth",
  awsRegion: process.env.AWS_REGION || "us-east-1",
};

const REQUIRED_FIELDS = [
  "ledger_seq",
  "captured_at",
  "side",
  "level_index",
  "price",
  "amount",
] as const;

export class OrderBookDepthSnapshotExporter {
  private config: OrderBookDepthSnapshotExporterConfig;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastExportRows: OrderBookDepthExportRow[] = [];

  constructor(config?: Partial<OrderBookDepthSnapshotExporterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public getConfig(): OrderBookDepthSnapshotExporterConfig {
    return { ...this.config };
  }

  public buildExportRows(snapshot: OrderBookSnapshot): OrderBookDepthExportRow[] {
    const rows: OrderBookDepthExportRow[] = [];
    for (const side of ["bid", "ask"] as const) {
      const levels = (side === "bid" ? snapshot.bids : snapshot.asks)
        .slice()
        .sort((a, b) =>
          side === "bid" ? b.price - a.price : a.price - b.price,
        )
        .slice(0, this.config.topLevelsPerSide);

      levels.forEach((level, index) => {
        rows.push({
          ledger_seq: snapshot.ledgerSeq,
          captured_at: snapshot.capturedAt,
          side,
          level_index: index + 1,
          price: Number(level.price),
          amount: Number(level.amount),
        });
      });
    }

    return rows;
  }

  public validateExportSchema(
    rows: OrderBookDepthExportRow[],
  ): OrderBookDepthSchemaValidation {
    const requiredFields = [...REQUIRED_FIELDS];
    const missingColumns = requiredFields.filter(
      (field) => !rows.some((row) => Object.prototype.hasOwnProperty.call(row, field)),
    );

    if (rows.length === 0) {
      return {
        valid: false,
        requiredFields,
        missingColumns: requiredFields,
        invalidRowCount: 0,
        rowCount: 0,
      };
    }

    let invalidRowCount = 0;
    for (const row of rows) {
      const hasRequiredFields = requiredFields.every((field) =>
        Object.prototype.hasOwnProperty.call(row, field),
      );
      const sideOk = row.side === "bid" || row.side === "ask";
      const priceOk = Number.isFinite(row.price) && row.price > 0;
      const amountOk = Number.isFinite(row.amount) && row.amount > 0;
      const levelIndexOk = Number.isInteger(row.level_index) && row.level_index > 0;
      const ledgerOk = Number.isInteger(row.ledger_seq) && row.ledger_seq >= 0;
      const capturedAtOk = typeof row.captured_at === "string" && row.captured_at.length > 0;

      if (
        !hasRequiredFields ||
        !sideOk ||
        !priceOk ||
        !amountOk ||
        !levelIndexOk ||
        !ledgerOk ||
        !capturedAtOk
      ) {
        invalidRowCount += 1;
      }
    }

    return {
      valid: missingColumns.length === 0 && invalidRowCount === 0,
      requiredFields,
      missingColumns,
      invalidRowCount,
      rowCount: rows.length,
    };
  }

  public async exportSnapshot(
    snapshot: OrderBookSnapshot,
  ): Promise<OrderBookDepthExportResult | null> {
    if (!this.config.enabled) {
      return null;
    }

    if (
      snapshot.ledgerSeq % this.config.exportIntervalLedgers !== 0 &&
      snapshot.ledgerSeq !== 0
    ) {
      return null;
    }

    const rows = this.buildExportRows(snapshot);
    const validation = this.validateExportSchema(rows);
    if (!validation.valid) {
      logger.warn(
        `[OrderBookDepthSnapshotExporter] Snapshot schema validation failed for ledger ${snapshot.ledgerSeq}:`,
        validation,
      );
      return null;
    }

    this.lastExportRows = rows;

    const bucketName = this.config.bucketName;
    if (!bucketName || bucketName.trim().length === 0) {
      logger.warn(
        "[OrderBookDepthSnapshotExporter] S3 bucket not configured; snapshot export skipped",
      );
      return null;
    }

    const dateKey = new Date(snapshot.capturedAt).toISOString().slice(0, 10);
    const key = `${this.config.s3Prefix}/${dateKey}/ledger_${snapshot.ledgerSeq}.parquet`;

    try {
      const fileDirectory = await fs.mkdtemp(join(tmpdir(), "orderbook-depth-"));
      const filePath = join(fileDirectory, `ledger_${snapshot.ledgerSeq}.parquet`);

      const schema = new ParquetSchema({
        ledger_seq: { type: "INT64", optional: false },
        captured_at: { type: "UTF8", optional: false },
        side: { type: "UTF8", optional: false },
        level_index: { type: "INT32", optional: false },
        price: { type: "DOUBLE", optional: false },
        amount: { type: "DOUBLE", optional: false },
      });

      const writer = await ParquetWriter.openFile(schema, filePath);
      for (const row of rows) {
        await writer.appendRow(row);
      }
      await writer.close();

      const client = this.config.s3Client ?? new S3Client({ region: this.config.awsRegion });
      await client.send(
        new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: createReadStream(filePath),
          ContentType: "application/octet-stream",
        }),
      );
      await fs.rm(fileDirectory, { recursive: true, force: true });

      const result: OrderBookDepthExportResult = {
        bucket: bucketName,
        key,
        ledgerSeq: snapshot.ledgerSeq,
        rowsWritten: rows.length,
        exportedAt: new Date().toISOString(),
      };

      logger.info(
        `[OrderBookDepthSnapshotExporter] Exported ${rows.length} order book levels to s3://${bucketName}/${key}`,
      );
      return result;
    } catch (error) {
      logger.error(
        `[OrderBookDepthSnapshotExporter] Failed to export snapshot for ledger ${snapshot.ledgerSeq}:`,
        error,
      );
      return null;
    }
  }

  public async runDailyHealthCheck(): Promise<OrderBookDepthHealthReport> {
    const requiredFields = [...REQUIRED_FIELDS];
    const checkedAt = new Date().toISOString();

    if (!this.config.enabled || this.lastExportRows.length === 0) {
      return {
        ok: true,
        checkedAt,
        requiredFields,
        rowCount: this.lastExportRows.length,
        valid: true,
        skipped: this.lastExportRows.length === 0,
      };
    }

    const validation = this.validateExportSchema(this.lastExportRows);
    return {
      ok: validation.valid,
      checkedAt,
      requiredFields,
      rowCount: validation.rowCount,
      valid: validation.valid,
    };
  }

  public startDailyHealthCheck(intervalMs = 24 * 60 * 60 * 1000): void {
    if (this.healthCheckTimer) {
      return;
    }
    this.healthCheckTimer = setInterval(() => {
      void this.runDailyHealthCheck().catch((error) => {
        logger.error(
          "[OrderBookDepthSnapshotExporter] Daily health check failed:",
          error,
        );
      });
    }, intervalMs);
  }

  public stopDailyHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}

let exporterInstance: OrderBookDepthSnapshotExporter | null = null;

export function getOrderBookDepthSnapshotExporter(
  config?: Partial<OrderBookDepthSnapshotExporterConfig>,
): OrderBookDepthSnapshotExporter {
  if (!exporterInstance || config) {
    exporterInstance = new OrderBookDepthSnapshotExporter(config);
  }
  return exporterInstance;
}

export function resetOrderBookDepthSnapshotExporter(): void {
  if (exporterInstance) {
    exporterInstance.stopDailyHealthCheck();
    exporterInstance = null;
  }
}

export const orderBookDepthSnapshotExporter = getOrderBookDepthSnapshotExporter();
