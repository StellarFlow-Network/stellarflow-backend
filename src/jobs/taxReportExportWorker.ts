import { promises as fs } from "fs";
import path from "path";
import { getRedisClient } from "../lib/redis";
import { logger } from "../utils/logger";
import {
  TaxReportService,
  taxReportService,
  type TaxExportFormat,
} from "../services/taxReportService";

/**
 * Issue #1009 – background worker that streams large tax-report exports to
 * disk. HTTP requests that would exceed the synchronous response budget enqueue
 * a job here and poll its status by `jobId`.
 */

export const TAX_REPORT_EXPORT_QUEUE = "tax-report-export:queue";
export const TAX_REPORT_EXPORT_STATUS_PREFIX = "tax-report-export:status:";
export const DEFAULT_TAX_REPORT_EXPORT_DIR = "exports/tax-reports";

const DEFAULT_POLL_INTERVAL_MS = 2_000;

export interface TaxReportExportJob {
  jobId: string;
  address: string;
  format: TaxExportFormat;
  from?: string;
  to?: string;
}

export interface TaxReportExportStatus {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed";
  address: string;
  format: TaxExportFormat;
  filePath?: string;
  rowCount?: number;
  error?: string;
  updatedAt: string;
}

interface WorkerDependencies {
  service?: TaxReportService;
  getRedis?: typeof getRedisClient;
  outputDir?: string;
  pollIntervalMs?: number;
  now?: () => Date;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TaxReportExportWorker {
  private readonly service: TaxReportService;
  private readonly redisProvider: typeof getRedisClient;
  private readonly outputDir: string;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private lastHeartbeatAt: number | null = null;

  constructor(deps: WorkerDependencies = {}) {
    this.service = deps.service ?? taxReportService;
    this.redisProvider = deps.getRedis ?? getRedisClient;
    this.outputDir =
      deps.outputDir ??
      process.env.TAX_REPORT_EXPORT_DIR ??
      DEFAULT_TAX_REPORT_EXPORT_DIR;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = deps.now ?? (() => new Date());
  }

  async enqueue(job: Omit<TaxReportExportJob, "jobId"> & { jobId?: string }): Promise<TaxReportExportJob> {
    const jobId = job.jobId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const queued: TaxReportExportJob = {
      jobId,
      address: job.address,
      format: job.format,
    };
    if (job.from !== undefined) queued.from = job.from;
    if (job.to !== undefined) queued.to = job.to;

    const redis = this.redisProvider();
    await this.writeStatus({
      jobId,
      status: "queued",
      address: job.address,
      format: job.format,
      updatedAt: this.now().toISOString(),
    });
    if (!redis?.isOpen) {
      throw new Error("Redis is unavailable; cannot enqueue export job");
    }
    await redis.lPush(TAX_REPORT_EXPORT_QUEUE, JSON.stringify(queued));
    return queued;
  }

  async getStatus(jobId: string): Promise<TaxReportExportStatus | null> {
    const redis = this.redisProvider();
    if (!redis?.isOpen) return null;
    const raw = await redis.get(`${TAX_REPORT_EXPORT_STATUS_PREFIX}${jobId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TaxReportExportStatus;
    } catch {
      return null;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
    logger.info("[TaxReportExportWorker] Started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
    logger.info("[TaxReportExportWorker] Stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  getLastHeartbeatAt(): number | null {
    return this.lastHeartbeatAt;
  }

  getHeartbeatTimeoutMs(): number {
    return this.pollIntervalMs * 5;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      this.lastHeartbeatAt = this.now().getTime();
      const redis = this.redisProvider();
      if (!redis?.isOpen) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      let job: TaxReportExportJob | null = null;
      try {
        const raw = await redis.rPop(TAX_REPORT_EXPORT_QUEUE);
        if (raw) job = JSON.parse(raw) as TaxReportExportJob;
      } catch (error) {
        logger.warn(
          `[TaxReportExportWorker] Failed to dequeue job: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (!job) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      await this.process(job);
    }
  }

  private async process(job: TaxReportExportJob): Promise<void> {
    await this.writeStatus({
      jobId: job.jobId,
      status: "processing",
      address: job.address,
      format: job.format,
      updatedAt: this.now().toISOString(),
    });

    try {
      const request = {
        address: job.address,
        format: job.format,
        ...(job.from ? { from: new Date(job.from) } : {}),
        ...(job.to ? { to: new Date(job.to) } : {}),
      };
      const report = await this.service.generateReport(request);

      await fs.mkdir(this.outputDir, { recursive: true });
      const filePath = path.join(
        this.outputDir,
        `${job.address}-${job.format}-${job.jobId}.csv`,
      );
      await fs.writeFile(filePath, report.csv, "utf8");

      await this.writeStatus({
        jobId: job.jobId,
        status: "completed",
        address: job.address,
        format: job.format,
        filePath,
        rowCount: report.rowCount,
        updatedAt: this.now().toISOString(),
      });
    } catch (error) {
      await this.writeStatus({
        jobId: job.jobId,
        status: "failed",
        address: job.address,
        format: job.format,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: this.now().toISOString(),
      });
      logger.error("[TaxReportExportWorker] Job failed", error);
    }
  }

  private async writeStatus(status: TaxReportExportStatus): Promise<void> {
    const redis = this.redisProvider();
    if (!redis?.isOpen) return;
    try {
      await redis.set(
        `${TAX_REPORT_EXPORT_STATUS_PREFIX}${status.jobId}`,
        JSON.stringify(status),
        { EX: 24 * 60 * 60 },
      );
    } catch (error) {
      logger.warn(
        `[TaxReportExportWorker] Failed to persist status: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export const taxReportExportWorker = new TaxReportExportWorker();
