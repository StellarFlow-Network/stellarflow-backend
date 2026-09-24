import { getRedisClient } from "../lib/redis";
import { broadcastToSessions } from "../lib/socket";
import { logger } from "../utils/logger";

export const BAD_DEBT_COVERED_EVENT = "BadDebtCoveredByReserve";
export const BAD_DEBT_EVENT_STREAM = "events:vault-bad-debt";

export interface ReserveAssetPosition {
  asset: string;
  amount: number;
  price: number;
}

export interface InsolventVaultPosition {
  id: string;
  accountId: string;
  recipient: string;
  collateral: ReserveAssetPosition[];
  debt: ReserveAssetPosition[];
}

export interface ReserveTransferRequest {
  idempotencyKey: string;
  positionId: string;
  recipient: string;
  asset: string;
  amount: number;
}

export interface ReserveFundTransfer {
  transfer(request: ReserveTransferRequest): Promise<{ transactionId: string }>;
}

export interface VaultInsolvencyScanner {
  scan(): Promise<InsolventVaultPosition[]>;
}

export interface BadDebtCoverage {
  asset: string;
  amount: number;
  value: number;
  transactionId: string;
}

export interface BadDebtCoveredEvent {
  event: typeof BAD_DEBT_COVERED_EVENT;
  positionId: string;
  accountId: string;
  recipient: string;
  collateralValue: number;
  debtValue: number;
  badDebtValue: number;
  covered: BadDebtCoverage[];
  occurredAt: string;
}

export interface BadDebtReserveFundOptions {
  intervalMs?: number;
  lockTtlSeconds?: number;
  coverageTtlSeconds?: number;
  epsilon?: number;
}

function valueOf(position: ReserveAssetPosition): number {
  return position.amount * position.price;
}

function validateAssetPosition(position: ReserveAssetPosition): void {
  if (
    !position.asset ||
    !Number.isFinite(position.amount) ||
    position.amount < 0 ||
    !Number.isFinite(position.price) ||
    position.price < 0
  ) {
    throw new Error(`Invalid reserve position for asset ${position.asset}`);
  }
}

/** Covers only the residual debt after collateral value has been exhausted. */
export class BadDebtReserveFundService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;
  private readonly intervalMs: number;
  private readonly lockTtlSeconds: number;
  private readonly coverageTtlSeconds: number;
  private readonly epsilon: number;
  private readonly coveredPositions = new Set<string>();

  constructor(
    private readonly scanner: VaultInsolvencyScanner,
    private readonly reserve: ReserveFundTransfer,
    options: BadDebtReserveFundOptions = {},
  ) {
    this.intervalMs =
      options.intervalMs ??
      Number(process.env.BAD_DEBT_RESERVE_SCAN_INTERVAL_MS ?? "5000");
    this.lockTtlSeconds =
      options.lockTtlSeconds ??
      Number(process.env.BAD_DEBT_RESERVE_LOCK_TTL_SECONDS ?? "300");
    this.coverageTtlSeconds =
      options.coverageTtlSeconds ??
      Number(process.env.BAD_DEBT_RESERVE_COVERAGE_TTL_SECONDS ?? "2592000");
    this.epsilon = options.epsilon ?? 1e-12;
  }

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
    if (this.scanning) return 0;
    this.scanning = true;
    try {
      const positions = await this.scanner.scan();
      let covered = 0;
      for (const position of positions) {
        const event = await this.coverIfInsolvent(position);
        if (event) covered += 1;
      }
      return covered;
    } finally {
      this.scanning = false;
    }
  }

  async coverIfInsolvent(
    position: InsolventVaultPosition,
  ): Promise<BadDebtCoveredEvent | null> {
    for (const asset of [...position.collateral, ...position.debt]) {
      validateAssetPosition(asset);
    }

    const collateralValue = position.collateral.reduce(
      (total, asset) => total + valueOf(asset),
      0,
    );
    const debtValue = position.debt.reduce(
      (total, asset) => total + valueOf(asset),
      0,
    );
    const badDebtValue = debtValue - collateralValue;
    if (badDebtValue <= this.epsilon) return null;

    const lockKey = `bad-debt-reserve:coverage:${position.id}`;
    if (!(await this.claimCoverage(lockKey))) return null;

    try {
      const covered = await this.transferResidualDebt(
        position,
        debtValue,
        badDebtValue,
      );
      const event: BadDebtCoveredEvent = {
        event: BAD_DEBT_COVERED_EVENT,
        positionId: position.id,
        accountId: position.accountId,
        recipient: position.recipient,
        collateralValue,
        debtValue,
        badDebtValue,
        covered,
        occurredAt: new Date().toISOString(),
      };
      await this.emitCoverageEvent(event);
      await this.completeCoverage(lockKey, position.id);
      return event;
    } catch (error) {
      await this.releaseCoverage(lockKey);
      throw error;
    }
  }

  private async transferResidualDebt(
    position: InsolventVaultPosition,
    debtValue: number,
    badDebtValue: number,
  ): Promise<BadDebtCoverage[]> {
    const coverageRatio = badDebtValue / debtValue;
    const covered: BadDebtCoverage[] = [];
    for (const debt of position.debt) {
      const amount = debt.amount * coverageRatio;
      if (amount <= this.epsilon) continue;
      const result = await this.reserve.transfer({
        idempotencyKey: `bad-debt:${position.id}:${debt.asset}`,
        positionId: position.id,
        recipient: position.recipient,
        asset: debt.asset,
        amount,
      });
      covered.push({
        asset: debt.asset,
        amount,
        value: amount * debt.price,
        transactionId: result.transactionId,
      });
    }
    return covered;
  }

  private async claimCoverage(key: string): Promise<boolean> {
    const positionId = key.slice("bad-debt-reserve:coverage:".length);
    if (this.coveredPositions.has(positionId)) return false;
    const redis = getRedisClient();
    if (!redis?.isOpen) return true;
    if (await redis.get(key)) return false;
    const result = await redis.set(key, "processing", {
      NX: true,
      EX: this.lockTtlSeconds,
    });
    return result === "OK";
  }

  private async releaseCoverage(key: string): Promise<void> {
    const redis = getRedisClient();
    if (redis?.isOpen) await redis.del(key);
  }

  private async completeCoverage(key: string, positionId: string): Promise<void> {
    this.coveredPositions.add(positionId);
    const redis = getRedisClient();
    if (redis?.isOpen) {
      await redis.set(key, "covered", { EX: this.coverageTtlSeconds });
    }
  }

  private async emitCoverageEvent(event: BadDebtCoveredEvent): Promise<void> {
    logger.info(`[${BAD_DEBT_COVERED_EVENT}] ${JSON.stringify(event)}`);
    broadcastToSessions(BAD_DEBT_COVERED_EVENT, event);

    const redis = getRedisClient();
    if (redis?.isOpen) {
      await redis.xAdd(BAD_DEBT_EVENT_STREAM, "*", {
        event: BAD_DEBT_COVERED_EVENT,
        payload: JSON.stringify(event),
      });
    }
  }
}