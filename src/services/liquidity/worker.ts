import { calculateRebalancingPlan } from "./calculation";
import type {
  LiquidityPoolConfig,
  LiquidityRateSource,
  RebalancingAlertSender,
  RebalancingQueue,
  ReserveSource,
  ValuedReserve,
} from "./types";

export const FIVE_MINUTES_MS = 5 * 60 * 1000;

export class LiquidityRebalancingWorker {
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private lastHeartbeatAt: number | null = null;

  constructor(
    private readonly pools: LiquidityPoolConfig[],
    private readonly reserves: ReserveSource,
    private readonly rates: LiquidityRateSource,
    private readonly queue: RebalancingQueue,
    private readonly alerts: RebalancingAlertSender,
    private readonly intervalMs = FIVE_MINUTES_MS,
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("Liquidity rebalancing interval must be positive");
    }
  }

  start(): void {
    if (this.timer || this.pools.length === 0) return;

    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.lastHeartbeatAt = Date.now();

    try {
      await Promise.allSettled(
        this.pools.map(async (pool) => {
          try {
            await this.pollPool(pool);
          } catch (error) {
            console.error(`Liquidity poll failed for ${pool.key}:`, error);
          }
        }),
      );
    } finally {
      this.polling = false;
    }
  }

  getLastHeartbeatAt(): number | null {
    return this.lastHeartbeatAt;
  }

  getHeartbeatTimeoutMs(): number {
    return Math.max(this.intervalMs * 2, 15_000);
  }

  private async pollPool(pool: LiquidityPoolConfig): Promise<void> {
    const [balances, unitsPerXlm] = await Promise.all([
      this.reserves.getReserves(pool),
      Promise.all(
        pool.assets.map((asset) => this.rates.getUnitsPerXlm(asset.code)),
      ) as Promise<[number, number]>,
    ]);

    const valuedReserves = pool.assets.map((asset, index) => {
      const balance = balances[index];
      const rate = unitsPerXlm[index];
      if (balance === undefined || rate === undefined) {
        throw new Error(`Missing reserve data for pool ${pool.key}`);
      }
      return {
        ...asset,
        balance,
        unitsPerXlm: rate,
        normalizedValue: balance / rate,
      };
    }) as [ValuedReserve, ValuedReserve];

    const plan = calculateRebalancingPlan(
      pool.key,
      pool.anchorAccount,
      valuedReserves,
      pool.managerAccounts,
    );
    if (!plan) return;

    const queued = await this.queue.enqueueUnlessPending(plan);
    if (!queued) return;

    try {
      await this.alerts.send(queued, pool);
    } catch (error) {
      console.error(
        `Liquidity manager alert failed for swap ${queued.id}:`,
        error,
      );
    }
  }
}
