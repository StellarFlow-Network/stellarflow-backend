import prisma from "../lib/prisma";

export interface PoolTrade {
  poolId: string;
  executedAt: Date;
  volume: number;
  fee: number;
}

export interface PoolTvlSnapshot {
  poolId: string;
  tvl: number;
}

export interface PoolAnalyticsDataSource {
  listTrades(poolId: string, since: Date, until: Date): Promise<PoolTrade[]>;
  getTvl(poolId: string): Promise<PoolTvlSnapshot>;
}

export interface PoolVolumeMetric {
  poolId: string;
  timestamp: Date;
  volume24h: number;
  fees24h: number;
  tvl: number;
}

export interface PoolVolumeAnalyticsOptions {
  intervalMs?: number;
  lookbackMs?: number;
  bucketMs?: number;
}

/** Computes and persists rolling pool volume, fees, and TVL snapshots. */
export class LiquidityPoolVolumeAnalyticsService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly intervalMs: number;
  private readonly lookbackMs: number;
  private readonly bucketMs: number;

  constructor(
    private readonly source: PoolAnalyticsDataSource,
    options: PoolVolumeAnalyticsOptions = {},
  ) {
    this.intervalMs =
      options.intervalMs ??
      Number(process.env.LIQUIDITY_ANALYTICS_INTERVAL_MS ?? "300000");
    this.lookbackMs = options.lookbackMs ?? 24 * 60 * 60 * 1000;
    this.bucketMs = options.bucketMs ?? 60 * 60 * 1000;
  }

  start(poolIds: string[]): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(poolIds), this.intervalMs);
    void this.refresh(poolIds);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(
    poolIds: string[],
    now = new Date(),
  ): Promise<PoolVolumeMetric[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const since = new Date(now.getTime() - this.lookbackMs);
      const timestamp = new Date(
        Math.floor(now.getTime() / this.bucketMs) * this.bucketMs,
      );
      const metrics: PoolVolumeMetric[] = [];

      for (const poolId of poolIds) {
        const [trades, reserve] = await Promise.all([
          this.source.listTrades(poolId, since, now),
          this.source.getTvl(poolId),
        ]);
        const metric: PoolVolumeMetric = {
          poolId,
          timestamp,
          volume24h: trades.reduce((total, trade) => total + trade.volume, 0),
          fees24h: trades.reduce((total, trade) => total + trade.fee, 0),
          tvl: reserve.tvl,
        };
        await prisma.poolVolumeAnalytics.upsert({
          where: { poolId_timestamp: { poolId, timestamp } },
          create: metric,
          update: {
            volume24h: metric.volume24h,
            fees24h: metric.fees24h,
            tvl: metric.tvl,
          },
        });
        metrics.push(metric);
      }
      return metrics;
    } finally {
      this.running = false;
    }
  }

  async getLatest(poolId?: string): Promise<PoolVolumeMetric[]> {
    const rows = await prisma.poolVolumeAnalytics.findMany({
      ...(poolId ? { where: { poolId } } : {}),
      orderBy: [{ poolId: "asc" }, { timestamp: "desc" }],
      distinct: ["poolId"],
    });
    return rows.map((row) => ({
      poolId: row.poolId,
      timestamp: row.timestamp,
      volume24h: Number(row.volume24h),
      fees24h: Number(row.fees24h),
      tvl: Number(row.tvl),
    }));
  }
}
