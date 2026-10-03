import { getRedisClient } from "../lib/redis";

export interface VaultPosition {
  id: string;
  userId: string;
  healthFactor: number;
  collateralAsset: string;
  collateralAmount: number;
  /** Estimated profit in stroops used to cap fee-bumped liquidation calls. */
  estimatedProfitStroops?: number;
}

export interface VaultPositionScanner {
  findPositionsByHealthFactor(
    minimum: number,
    maximum: number,
  ): Promise<VaultPosition[]>;
}

export interface VaultRiskNotifier {
  sendPush(position: VaultPosition): Promise<void>;
  sendEmail(position: VaultPosition): Promise<void>;
}

/** Scans the pre-liquidation band and rate-limits each user/position alert in Redis. */
export class YieldVaultLiquidationRiskService {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly scanner: VaultPositionScanner,
    private readonly notifier: VaultRiskNotifier,
    private readonly intervalMs = Number(
      process.env.VAULT_RISK_SCAN_INTERVAL_MS ?? "300000",
    ),
    private readonly alertCooldownSeconds = Number(
      process.env.VAULT_RISK_ALERT_COOLDOWN_SECONDS ?? "86400",
    ),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
    void this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async scan(): Promise<number> {
    const positions = await this.scanner.findPositionsByHealthFactor(
      1.05,
      1.15,
    );
    let dispatched = 0;
    for (const position of positions) {
      if (!(await this.claimAlert(position))) continue;
      try {
        await Promise.all([
          this.notifier.sendPush(position),
          this.notifier.sendEmail(position),
        ]);
        dispatched += 1;
      } catch (error) {
        await this.releaseAlert(position);
        console.error(
          "Failed to dispatch vault liquidation risk alert:",
          error,
        );
      }
    }
    return dispatched;
  }

  private key(position: VaultPosition): string {
    return `vault-liquidation-risk-alert:${position.userId}:${position.id}`;
  }

  private async claimAlert(position: VaultPosition): Promise<boolean> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return true;
    const result = await redis.set(
      this.key(position),
      new Date().toISOString(),
      { NX: true, EX: this.alertCooldownSeconds },
    );
    return result === "OK";
  }

  private async releaseAlert(position: VaultPosition): Promise<void> {
    const redis = getRedisClient();
    if (redis?.isOpen) await redis.del(this.key(position));
  }
}
