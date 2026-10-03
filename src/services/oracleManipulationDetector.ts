import prisma from "../lib/prisma";
import { logger } from "../utils/logger";
import { AlertSeverity, AlertType, NotificationService } from "./notificationService";

export interface OraclePriceTick {
  poolId: string;
  ledger: number;
  spotPrice: number;
  observedAt?: Date;
}

export interface OracleManipulationAlert {
  poolId: string;
  ledger: number;
  spotPrice: number;
  twapPrice: number;
  deviationPercent: number;
  detectedAt: string;
}

const WINDOW_MS = 30 * 60 * 1000;

export class OracleManipulationDetector {
  private readonly ticks = new Map<string, OraclePriceTick[]>();
  private readonly pausedPools = new Set<string>();

  constructor(
    private readonly notifications = new NotificationService(),
    private readonly thresholdPercent = Number(process.env.ORACLE_MANIPULATION_THRESHOLD_PERCENT ?? "10"),
  ) {}

  isPoolPaused(poolId: string): boolean { return this.pausedPools.has(poolId); }
  assertPoolOperational(poolId: string): void {
    if (this.isPoolPaused(poolId)) throw new Error(`Pool ${poolId} is paused after an oracle manipulation alert`);
  }
  resumePool(poolId: string): void { this.pausedPools.delete(poolId); }

  async observe(tick: OraclePriceTick): Promise<OracleManipulationAlert | null> {
    if (!Number.isFinite(tick.spotPrice) || tick.spotPrice <= 0) throw new Error("Spot price must be a finite positive number");
    const observedAt = tick.observedAt ?? new Date();
    const history = (this.ticks.get(tick.poolId) ?? []).filter((item) => observedAt.getTime() - (item.observedAt ?? new Date()).getTime() <= WINDOW_MS);
    const twapPrice = history.length === 0
      ? tick.spotPrice
      : history.reduce((total, item) => total + item.spotPrice, 0) / history.length;
    history.push({ ...tick, observedAt });
    this.ticks.set(tick.poolId, history);
    const client = prisma as any;
    await client.oraclePriceObservation?.create({ data: { poolId: tick.poolId, ledger: tick.ledger, spotPrice: tick.spotPrice, twapPrice, observedAt } }).catch((error: unknown) => logger.warn("[OracleDetector] Failed to persist observation", error));
    const deviationPercent = Math.abs((tick.spotPrice / twapPrice - 1) * 100);
    if (deviationPercent <= this.thresholdPercent) return null;

    this.pausedPools.add(tick.poolId);
    const alert: OracleManipulationAlert = { poolId: tick.poolId, ledger: tick.ledger, spotPrice: tick.spotPrice, twapPrice, deviationPercent, detectedAt: observedAt.toISOString() };
    await client.oracleManipulationIncident?.upsert({ where: { poolId_ledger: { poolId: tick.poolId, ledger: tick.ledger } }, create: { ...alert, detectedAt: observedAt }, update: { deviationPercent, status: "PAUSED" } }).catch((error: unknown) => logger.warn("[OracleDetector] Failed to persist incident", error));
    await this.notifications.sendAlert({ type: AlertType.PRICE_ANOMALY, severity: AlertSeverity.CRITICAL, title: "Oracle price manipulation detected", message: `Pool ${tick.poolId} deviated ${deviationPercent.toFixed(2)}% from its 30-minute TWAP in ledger ${tick.ledger}. Borrow and swap operations are paused.`, details: alert, timestamp: observedAt, service: "oracle-manipulation-detector" });
    return alert;
  }
}

export const oracleManipulationDetector = new OracleManipulationDetector();