import { Prisma } from "@prisma/client";

import prisma from "../../lib/prisma";
import stellarProvider from "../../lib/stellarProvider";
import { logger } from "../../utils/logger";
import { WebhookService } from "../webhook";
import { aggregateDailyStats, startOfUtcDay } from "./gasAggregator";
import type {
  GasDailyStats,
  GasMetrics,
  GasSampleSource,
  TrackedTxType,
  TxType,
} from "./gasMetrics.types";
import {
  extractGasMetrics,
  type TransactionResultLike,
} from "./gasMetricsExtractor";
import {
  evaluateSpike,
  resolveSpikeThresholds,
  type SpikeEvaluation,
} from "./gasSpikeDetector";
import { parseTxTypeAliases } from "./txTypeClassifier";

/**
 * Automated gas and CPU instruction profiler for contract calls (Issue #786).
 *
 * Two ingestion paths feed the same store:
 * - `profileTransaction`, called inline when this service submits a Soroban
 *   transaction, so our own costs are captured immediately.
 * - `runBackfill`, which polls `getTransactions` for the protocol contract so
 *   calls made by other clients are captured too.
 *
 * A daily rollup then produces the average cost per transaction type and
 * compares it against a trailing baseline to alert on unexpected spikes.
 */

const DEFAULT_BACKFILL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_BASELINE_DAYS = 7;
/** RPC caps getTransactions page size; 200 is the documented maximum. */
const BACKFILL_PAGE_LIMIT = 200;
/** Metrics the spike detector watches, with the field it reads from the rollup. */
const MONITORED_METRICS: ReadonlyArray<{
  metric: string;
  select: (stats: GasDailyStats) => number;
}> = [
  { metric: "avgCpuInstructions", select: (s) => s.avgCpuInstructions },
  { metric: "avgFeeChargedStroops", select: (s) => s.avgFeeChargedStroops },
  { metric: "avgRentFeeStroops", select: (s) => s.avgRentFeeStroops },
];

function toDecimal(value: bigint | number): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

export class GasProfilerService {
  private isRunning = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private backfillIntervalMs: number;
  private lastProcessedLedger = 0;
  private webhookService: WebhookService;
  private aliases: Record<string, TrackedTxType>;

  constructor(backfillIntervalMs?: number) {
    const configured = Number.parseInt(
      process.env.GAS_PROFILER_BACKFILL_INTERVAL_MS ?? "",
      10,
    );

    this.backfillIntervalMs =
      backfillIntervalMs ??
      (Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_BACKFILL_INTERVAL_MS);

    this.webhookService = new WebhookService();
    this.aliases = parseTxTypeAliases(process.env.GAS_PROFILER_TX_TYPE_ALIASES);
  }

  isEnabled(): boolean {
    return process.env.GAS_PROFILER_ENABLED !== "false";
  }

  /** Protocol contract whose transactions the backfill poller profiles. */
  getTargetContractId(): string | null {
    const id = process.env.CONTRACT_ID?.trim();
    return id && id.length > 0 ? id : null;
  }

  /**
   * Extracts and stores the cost of a single transaction.
   *
   * Never throws: profiling is observability, and a decode failure must not
   * fail the caller's submission.
   *
   * When `contractIdFilter` is set, samples for other contracts are skipped
   * (used by the backfill poller so only the protocol contract is stored).
   */
  async profileTransaction(
    response: TransactionResultLike,
    source: GasSampleSource,
    txHash?: string,
    contractIdFilter?: string | null,
  ): Promise<GasMetrics | null> {
    if (!this.isEnabled()) return null;

    try {
      const metrics = extractGasMetrics(response, {
        source,
        aliases: this.aliases,
        ...(txHash ? { txHash } : {}),
      });

      if (!metrics) return null;

      if (
        contractIdFilter &&
        metrics.contractId &&
        metrics.contractId !== contractIdFilter
      ) {
        return null;
      }

      // Backfill without a contractId on the sample (createContract, etc.) is
      // skipped when a filter is active — only invoked protocol calls count.
      if (contractIdFilter && !metrics.contractId) {
        return null;
      }

      await this.persistSample(metrics);
      return metrics;
    } catch (error) {
      logger.warn("[GasProfiler] Failed to profile transaction", {
        txHash: txHash ?? response.txHash,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Fetches a transaction from RPC by hash and profiles it.
   * Used after Horizon-submitted Soroban ops (e.g. storage rent bumps) where
   * the confirmation response does not include result meta XDR.
   */
  async profileByHash(
    txHash: string,
    source: GasSampleSource = "submission",
  ): Promise<GasMetrics | null> {
    if (!this.isEnabled() || !txHash) return null;

    try {
      const result = await stellarProvider
        .getRpcServer()
        .getTransaction(txHash);
      if (result.status === "NOT_FOUND") return null;
      return this.profileTransaction(result, source, txHash);
    } catch (error) {
      logger.warn("[GasProfiler] Failed to fetch transaction for profiling", {
        txHash,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Upserts on txHash so a transaction seen first at submission and again by
   * the backfill poller is recorded once rather than double-counted in the
   * daily averages.
   */
  private async persistSample(metrics: GasMetrics): Promise<void> {
    const data = {
      txType: metrics.txType,
      contractId: metrics.contractId,
      functionName: metrics.functionName,
      successful: metrics.successful,
      cpuInstructions: toDecimal(metrics.cpuInstructions),
      diskReadBytes: toDecimal(metrics.diskReadBytes),
      writeBytes: toDecimal(metrics.writeBytes),
      resourceFeeStroops: toDecimal(metrics.resourceFeeStroops),
      feeChargedStroops: toDecimal(metrics.feeChargedStroops),
      nonRefundableFeeStroops: toDecimal(metrics.nonRefundableFeeStroops),
      refundableFeeStroops: toDecimal(metrics.refundableFeeStroops),
      rentFeeStroops: toDecimal(metrics.rentFeeStroops),
      ledgerSeq: metrics.ledgerSeq,
      source: metrics.source,
      occurredAt: metrics.occurredAt,
    };

    await prisma.gasProfileSample.upsert({
      where: { txHash: metrics.txHash },
      create: { txHash: metrics.txHash, ...data },
      update: data,
    });
  }

  /**
   * Polls the RPC for transactions since the last processed ledger and profiles
   * any that invoke the configured protocol contract (`CONTRACT_ID`).
   */
  async runBackfill(): Promise<number> {
    if (!this.isEnabled()) return 0;

    const contractId = this.getTargetContractId();
    if (!contractId) {
      logger.warn(
        "[GasProfiler] CONTRACT_ID not configured — skipping backfill poll",
      );
      return 0;
    }

    const rpc = stellarProvider.getRpcServer();

    if (this.lastProcessedLedger === 0) {
      this.lastProcessedLedger = await this.resolveStartLedger(rpc);
    }

    let profiled = 0;

    try {
      const response = await rpc.getTransactions({
        startLedger: this.lastProcessedLedger + 1,
        pagination: { limit: BACKFILL_PAGE_LIMIT },
      });

      for (const tx of response.transactions ?? []) {
        const metrics = await this.profileTransaction(
          tx,
          "backfill",
          undefined,
          contractId,
        );
        if (metrics) profiled += 1;

        if (tx.ledger > this.lastProcessedLedger) {
          this.lastProcessedLedger = tx.ledger;
        }
      }

      if (profiled > 0) {
        logger.info(
          `[GasProfiler] Backfilled ${profiled} sample(s) through ledger ${this.lastProcessedLedger}`,
        );
      }
    } catch (error) {
      stellarProvider.reportFailure(error);
      logger.warn("[GasProfiler] Backfill poll failed", {
        startLedger: this.lastProcessedLedger + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return profiled;
  }

  /**
   * Resumes from the newest stored sample, falling back to the RPC's oldest
   * retained ledger. Starting from ledger 1 would be rejected, since RPC only
   * keeps a short history window.
   */
  private async resolveStartLedger(
    rpc: ReturnType<typeof stellarProvider.getRpcServer>,
  ): Promise<number> {
    const latestSample = await prisma.gasProfileSample
      .findFirst({
        orderBy: { ledgerSeq: "desc" },
        select: { ledgerSeq: true },
      })
      .catch(() => null);

    if (latestSample?.ledgerSeq) return latestSample.ledgerSeq;

    const latest = await rpc.getLatestLedger();

    try {
      const { oldestLedger } = await rpc.getTransactions({
        startLedger: latest.sequence,
        pagination: { limit: 1 },
      });
      return oldestLedger;
    } catch {
      return latest.sequence;
    }
  }

  /**
   * Rolls up a day's samples into per-type averages, then compares each metric
   * against the preceding days and alerts on a spike.
   */
  async runDailyAggregation(day: Date = new Date()): Promise<GasDailyStats[]> {
    if (!this.isEnabled()) return [];

    const dayStart = startOfUtcDay(day);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    const rows = await prisma.gasProfileSample.findMany({
      where: { occurredAt: { gte: dayStart, lt: dayEnd } },
    });

    if (rows.length === 0) {
      logger.info(
        `[GasProfiler] No samples to aggregate for ${dayStart.toISOString().slice(0, 10)}`,
      );
      return [];
    }

    const stats = aggregateDailyStats(rows.map(toGasMetrics), dayStart);

    for (const entry of stats) {
      await prisma.gasDailyAggregate.upsert({
        where: { day_txType: { day: entry.day, txType: entry.txType } },
        create: buildAggregateRow(entry),
        update: buildAggregateRow(entry),
      });
    }

    logger.info(
      `[GasProfiler] Aggregated ${rows.length} sample(s) into ${stats.length} type(s) for ${dayStart.toISOString().slice(0, 10)}`,
    );

    await this.detectSpikes(stats, dayStart);

    return stats;
  }

  /** Compares each type's metrics against its trailing daily baseline. */
  async detectSpikes(
    stats: readonly GasDailyStats[],
    day: Date,
  ): Promise<SpikeEvaluation[]> {
    const thresholds = resolveSpikeThresholds();
    const baselineDays = Number.parseInt(
      process.env.GAS_SPIKE_BASELINE_DAYS ?? "",
      10,
    );
    const windowDays =
      Number.isFinite(baselineDays) && baselineDays > 0
        ? baselineDays
        : DEFAULT_BASELINE_DAYS;

    const windowStart = new Date(
      day.getTime() - windowDays * 24 * 60 * 60 * 1000,
    );
    const spikes: SpikeEvaluation[] = [];

    for (const entry of stats) {
      const baseline = await prisma.gasDailyAggregate.findMany({
        where: {
          txType: entry.txType,
          day: { gte: windowStart, lt: day },
        },
        orderBy: { day: "asc" },
      });

      for (const { metric, select } of MONITORED_METRICS) {
        const evaluation = evaluateSpike(
          entry.txType,
          metric,
          select(entry),
          baseline.map((row) => Number(row[metric as keyof typeof row])),
          thresholds,
        );

        if (!evaluation.isSpike) {
          logger.debug("[GasProfiler] No spike", {
            txType: entry.txType,
            metric,
            reason: evaluation.reason,
          });
          continue;
        }

        spikes.push(evaluation);
        await this.alertSpike(evaluation);
      }
    }

    return spikes;
  }

  private async alertSpike(evaluation: SpikeEvaluation): Promise<void> {
    logger.warn("[GasProfiler] Gas usage spike detected", {
      txType: evaluation.txType,
      metric: evaluation.metric,
      current: evaluation.current,
      baselineMean: evaluation.baselineMean,
      percentIncrease: evaluation.percentIncrease,
    });

    await this.webhookService
      .sendGasSpikeAlert({
        txType: evaluation.txType,
        metric: evaluation.metric,
        current: evaluation.current,
        baselineMean: evaluation.baselineMean,
        percentIncrease: evaluation.percentIncrease,
        zScore: evaluation.zScore,
        baselineSampleCount: evaluation.baselineSampleCount,
        timestamp: new Date(),
      })
      .catch((error: Error) => {
        logger.error("[GasProfiler] Failed to send spike alert", {
          error: error.message,
        });
      });
  }

  /** Starts the backfill poller. The daily rollup is scheduled by the cron job. */
  async start(): Promise<void> {
    if (!this.isEnabled()) {
      logger.info("[GasProfiler] Disabled via GAS_PROFILER_ENABLED=false");
      return;
    }

    if (this.isRunning) {
      logger.warn("[GasProfiler] Service is already running");
      return;
    }

    this.isRunning = true;
    logger.info(
      `[GasProfiler] Started with ${this.backfillIntervalMs}ms backfill interval`,
    );

    await this.runBackfill().catch((error) => {
      logger.error("[GasProfiler] Initial backfill failed", { error });
    });

    this.timer = setInterval(() => {
      this.runBackfill().catch((error) => {
        logger.error("[GasProfiler] Backfill failed", { error });
      });
    }, this.backfillIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    logger.info("[GasProfiler] Stopped");
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      enabled: this.isEnabled(),
      backfillIntervalMs: this.backfillIntervalMs,
      lastProcessedLedger: this.lastProcessedLedger,
      contractId: this.getTargetContractId(),
    };
  }

  /**
   * Returns daily average cost rows for the read API.
   * Defaults to the last 7 UTC days when `from`/`to` are omitted.
   */
  async getDailyAverages(
    options: {
      from?: Date;
      to?: Date;
      txType?: string;
      limit?: number;
    } = {},
  ): Promise<
    Array<{
      day: Date;
      txType: string;
      sampleCount: number;
      avgCpuInstructions: number;
      avgFeeChargedStroops: number;
      avgRentFeeStroops: number;
      avgDiskReadBytes: number;
      avgWriteBytes: number;
      maxCpuInstructions: number;
      totalFeeChargedStroops: string;
    }>
  > {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const to = options.to
      ? startOfUtcDay(options.to)
      : startOfUtcDay(new Date());
    const from =
      options.from ?? new Date(to.getTime() - 6 * 24 * 60 * 60 * 1000);

    const rows = await prisma.gasDailyAggregate.findMany({
      where: {
        day: { gte: startOfUtcDay(from), lte: to },
        ...(options.txType ? { txType: options.txType } : {}),
      },
      orderBy: [{ day: "desc" }, { txType: "asc" }],
      take: limit,
    });

    return rows.map((row) => ({
      day: row.day,
      txType: row.txType,
      sampleCount: row.sampleCount,
      avgCpuInstructions: Number(row.avgCpuInstructions),
      avgFeeChargedStroops: Number(row.avgFeeChargedStroops),
      avgRentFeeStroops: Number(row.avgRentFeeStroops),
      avgDiskReadBytes: Number(row.avgDiskReadBytes),
      avgWriteBytes: Number(row.avgWriteBytes),
      maxCpuInstructions: Number(row.maxCpuInstructions),
      totalFeeChargedStroops: row.totalFeeChargedStroops.toFixed(0),
    }));
  }
}

/** Maps a persisted row back to the in-memory metric shape the aggregator expects. */
function toGasMetrics(row: {
  txHash: string;
  txType: string;
  contractId: string | null;
  functionName: string | null;
  successful: boolean;
  cpuInstructions: Prisma.Decimal;
  diskReadBytes: Prisma.Decimal;
  writeBytes: Prisma.Decimal;
  resourceFeeStroops: Prisma.Decimal;
  feeChargedStroops: Prisma.Decimal;
  nonRefundableFeeStroops: Prisma.Decimal;
  refundableFeeStroops: Prisma.Decimal;
  rentFeeStroops: Prisma.Decimal;
  ledgerSeq: number;
  source: string;
  occurredAt: Date;
}): GasMetrics {
  return {
    txHash: row.txHash,
    txType: row.txType as TxType,
    contractId: row.contractId,
    functionName: row.functionName,
    successful: row.successful,
    cpuInstructions: Number(row.cpuInstructions),
    diskReadBytes: Number(row.diskReadBytes),
    writeBytes: Number(row.writeBytes),
    resourceFeeStroops: BigInt(row.resourceFeeStroops.toFixed(0)),
    feeChargedStroops: BigInt(row.feeChargedStroops.toFixed(0)),
    nonRefundableFeeStroops: BigInt(row.nonRefundableFeeStroops.toFixed(0)),
    refundableFeeStroops: BigInt(row.refundableFeeStroops.toFixed(0)),
    rentFeeStroops: BigInt(row.rentFeeStroops.toFixed(0)),
    ledgerSeq: row.ledgerSeq,
    source: row.source as GasSampleSource,
    occurredAt: row.occurredAt,
  };
}

function buildAggregateRow(entry: GasDailyStats) {
  return {
    day: entry.day,
    txType: entry.txType,
    sampleCount: entry.sampleCount,
    avgCpuInstructions: toDecimal(entry.avgCpuInstructions),
    avgFeeChargedStroops: toDecimal(entry.avgFeeChargedStroops),
    avgRentFeeStroops: toDecimal(entry.avgRentFeeStroops),
    avgDiskReadBytes: toDecimal(entry.avgDiskReadBytes),
    avgWriteBytes: toDecimal(entry.avgWriteBytes),
    maxCpuInstructions: toDecimal(entry.maxCpuInstructions),
    totalFeeChargedStroops: toDecimal(entry.totalFeeChargedStroops),
  };
}

/** Lazy singleton, matching the pattern used by the other background services. */
let instance: GasProfilerService | null = null;

export function getGasProfilerService(): GasProfilerService {
  if (!instance) {
    instance = new GasProfilerService();
  }
  return instance;
}
