/**
 * RelayerGasReserveAllocator (Issue #1058)
 *
 * Splits the relayer gas-wallet fleet into two pools so emergency operations
 * can never be starved of XLM by routine traffic:
 *
 *   - EMERGENCY pool – 20% of the wallets (rounded up), reserved for contract
 *     pauses and liquidations.
 *   - STANDARD pool  – everything else, used by trade and deposit relayers.
 *
 * Rules
 * -----
 * 1. STANDARD operations are only ever handed STANDARD wallets. There is no
 *    code path from a standard request to an emergency wallet.
 * 2. EMERGENCY operations use an emergency wallet, and only fall back to a
 *    standard wallet if every emergency wallet is unusable — a late pause is
 *    worse than a pause paid for from the general pool.
 * 3. Each pool has its own low-balance threshold and alert rate-limit, so an
 *    emergency wallet running low alerts even when the standard pool is healthy.
 *
 * Partitioning is deterministic: wallets are ordered by id and the *oldest*
 * `ceil(20%)` are reserved. Adding wallets therefore never moves an existing
 * reserved wallet into the standard pool, so ops can pre-fund them once.
 *
 * All I/O (wallet listing, balance lookup, alerting) is injected, which keeps
 * the allocation logic unit-testable; `createDefaultRelayerGasReserveAllocator`
 * wires the production dependencies.
 */

import { logger } from "../utils/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export type GasWalletPool = "STANDARD" | "EMERGENCY";
export type GasOperationClass = "STANDARD" | "EMERGENCY";

export interface RelayerGasWallet {
  /** Stable, sortable identifier (the Relayer row id). */
  id: number;
  /** Stellar G... account that pays fees. */
  publicKey: string;
}

export interface WalletSnapshot extends RelayerGasWallet {
  pool: GasWalletPool;
  /** XLM balance, or null when the last lookup failed. */
  balanceXlm: number | null;
}

export interface PoolSnapshot {
  pool: GasWalletPool;
  thresholdXlm: number;
  totalBalanceXlm: number;
  wallets: WalletSnapshot[];
  lowBalanceWallets: number;
}

export interface GasReserveSnapshot {
  checkedAt: Date;
  /** False when the fleet is too small to hold back a reserve (fewer than 2). */
  reserveSatisfied: boolean;
  emergency: PoolSnapshot;
  standard: PoolSnapshot;
}

export interface GasWalletLease {
  wallet: RelayerGasWallet;
  /** Pool the wallet belongs to (an EMERGENCY op may be served from STANDARD). */
  pool: GasWalletPool;
  operation: GasOperationClass;
}

export interface LowBalanceAlert {
  pool: GasWalletPool;
  publicKey: string;
  balanceXlm: number;
  thresholdXlm: number;
  timestamp: Date;
}

export interface RelayerGasReserveConfig {
  /** Fraction of wallets held back for emergencies. Default 0.2. */
  reserveRatio: number;
  /** A wallet below this balance is not handed out at all. Default 2 XLM. */
  minOperatingBalanceXlm: number;
  /** Standard-pool low-balance alert threshold. Default 20 XLM. */
  standardAlertThresholdXlm: number;
  /** Emergency-pool low-balance alert threshold. Default 50 XLM. */
  emergencyAlertThresholdXlm: number;
  /** Minimum gap between repeated alerts for one wallet. Default 1 hour. */
  alertIntervalMs: number;
  /** How long a balance reading is trusted by acquire(). Default 30 s. */
  balanceCacheTtlMs: number;
  /** Background monitor cadence. Default 5 minutes. */
  checkIntervalMs: number;
}

export interface RelayerGasReserveDeps {
  listWallets(): Promise<RelayerGasWallet[]>;
  /** XLM balance of an account; 0 for accounts that do not exist yet. */
  fetchBalanceXlm(publicKey: string): Promise<number>;
  alert?(alert: LowBalanceAlert): Promise<void>;
  now?(): number;
}

export class GasReserveExhaustedError extends Error {
  constructor(public readonly operation: GasOperationClass) {
    super(
      operation === "STANDARD"
        ? "No standard-pool relayer wallet has enough XLM; emergency reserves are off limits to standard operations."
        : "No relayer wallet has enough XLM to fund an emergency operation.",
    );
    this.name = "GasReserveExhaustedError";
  }
}

export const DEFAULT_GAS_RESERVE_CONFIG: RelayerGasReserveConfig = {
  reserveRatio: 0.2,
  minOperatingBalanceXlm: 2,
  standardAlertThresholdXlm: 20,
  emergencyAlertThresholdXlm: 50,
  alertIntervalMs: 60 * 60 * 1000,
  balanceCacheTtlMs: 30 * 1000,
  checkIntervalMs: 5 * 60 * 1000,
};

// ─── Pure partitioning ────────────────────────────────────────────────────────

/** Number of wallets to hold back for a fleet of `total` wallets. */
export function reservedWalletCount(total: number, ratio: number): number {
  // A single wallet cannot be split; with none there is nothing to reserve.
  if (total < 2) return 0;
  return Math.min(Math.ceil(total * ratio), total - 1);
}

export function partitionWallets(
  wallets: RelayerGasWallet[],
  ratio: number,
): { emergency: RelayerGasWallet[]; standard: RelayerGasWallet[] } {
  const ordered = [...wallets].sort((a, b) => a.id - b.id);
  const reserved = reservedWalletCount(ordered.length, ratio);
  return {
    emergency: ordered.slice(0, reserved),
    standard: ordered.slice(reserved),
  };
}

// ─── Allocator ────────────────────────────────────────────────────────────────

export class RelayerGasReserveAllocator {
  private readonly config: RelayerGasReserveConfig;
  private readonly deps: RelayerGasReserveDeps;
  private readonly cursors: Record<GasWalletPool, number> = {
    STANDARD: 0,
    EMERGENCY: 0,
  };
  private readonly lastAlertAt = new Map<string, number>();

  private snapshot: GasReserveSnapshot | null = null;
  private snapshotAtMs = 0;
  private inFlight: Promise<GasReserveSnapshot> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    deps: RelayerGasReserveDeps,
    config: Partial<RelayerGasReserveConfig> = {},
  ) {
    this.deps = deps;
    this.config = { ...DEFAULT_GAS_RESERVE_CONFIG, ...config };
    if (!(this.config.reserveRatio > 0 && this.config.reserveRatio < 1)) {
      throw new RangeError("reserveRatio must be between 0 and 1 (exclusive)");
    }
  }

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  // ── Allocation ──────────────────────────────────────────────────────────

  /**
   * Pick a funded wallet for an operation.
   *
   * @throws GasReserveExhaustedError when no permitted wallet has enough XLM.
   */
  async acquire(operation: GasOperationClass): Promise<GasWalletLease> {
    const snap = await this.getSnapshot();
    const usable = (pool: PoolSnapshot): WalletSnapshot[] =>
      pool.wallets.filter(
        (w) =>
          w.balanceXlm !== null &&
          w.balanceXlm >= this.config.minOperatingBalanceXlm,
      );

    const standard = usable(snap.standard);
    if (operation === "STANDARD") {
      // Never look at the emergency pool for routine traffic.
      return this.lease(standard, "STANDARD", operation);
    }

    const emergency = usable(snap.emergency);
    if (emergency.length > 0) {
      return this.lease(emergency, "EMERGENCY", operation);
    }
    if (standard.length > 0) {
      logger.warn(
        "[GasReserve] Emergency pool exhausted; serving emergency operation from the standard pool",
      );
      return this.lease(standard, "STANDARD", operation);
    }
    throw new GasReserveExhaustedError(operation);
  }

  private lease(
    candidates: WalletSnapshot[],
    pool: GasWalletPool,
    operation: GasOperationClass,
  ): GasWalletLease {
    if (candidates.length === 0) throw new GasReserveExhaustedError(operation);
    // Round-robin so one wallet's sequence numbers aren't a bottleneck.
    const index = this.cursors[pool]++ % candidates.length;
    const { id, publicKey } = candidates[index]!;
    return { wallet: { id, publicKey }, pool, operation };
  }

  // ── Monitoring ──────────────────────────────────────────────────────────

  /** Latest balances, refreshed when older than `balanceCacheTtlMs`. */
  async getSnapshot(): Promise<GasReserveSnapshot> {
    const fresh =
      this.snapshot !== null &&
      this.nowMs() - this.snapshotAtMs < this.config.balanceCacheTtlMs;
    if (fresh) return this.snapshot!;
    return this.refresh();
  }

  /**
   * Re-read every wallet balance and raise low-balance alerts. Each pool is
   * judged against its own threshold, independently of the other.
   */
  refresh(): Promise<GasReserveSnapshot> {
    // Concurrent callers share one round of Horizon lookups.
    if (!this.inFlight) {
      this.inFlight = this.doRefresh().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async doRefresh(): Promise<GasReserveSnapshot> {
    const wallets = await this.deps.listWallets();
    const { emergency, standard } = partitionWallets(
      wallets,
      this.config.reserveRatio,
    );

    const read = async (
      list: RelayerGasWallet[],
      pool: GasWalletPool,
    ): Promise<WalletSnapshot[]> =>
      Promise.all(
        list.map(async (wallet) => {
          try {
            const balanceXlm = await this.deps.fetchBalanceXlm(wallet.publicKey);
            return { ...wallet, pool, balanceXlm };
          } catch (err) {
            logger.error(
              `[GasReserve] Balance lookup failed for ${pool} wallet ${wallet.publicKey.slice(0, 8)}…`,
              err,
            );
            return { ...wallet, pool, balanceXlm: null };
          }
        }),
      );

    const [emergencyWallets, standardWallets] = await Promise.all([
      read(emergency, "EMERGENCY"),
      read(standard, "STANDARD"),
    ]);

    const snap: GasReserveSnapshot = {
      checkedAt: new Date(this.nowMs()),
      reserveSatisfied: emergency.length > 0,
      emergency: this.summarize(
        "EMERGENCY",
        this.config.emergencyAlertThresholdXlm,
        emergencyWallets,
      ),
      standard: this.summarize(
        "STANDARD",
        this.config.standardAlertThresholdXlm,
        standardWallets,
      ),
    };

    if (!snap.reserveSatisfied && wallets.length > 0) {
      logger.warn(
        "[GasReserve] Fewer than 2 relayer wallets: no emergency reserve can be held back",
      );
    }

    this.snapshot = snap;
    this.snapshotAtMs = this.nowMs();
    await this.raiseAlerts(snap);
    return snap;
  }

  private summarize(
    pool: GasWalletPool,
    thresholdXlm: number,
    wallets: WalletSnapshot[],
  ): PoolSnapshot {
    return {
      pool,
      thresholdXlm,
      wallets,
      totalBalanceXlm: wallets.reduce((sum, w) => sum + (w.balanceXlm ?? 0), 0),
      lowBalanceWallets: wallets.filter(
        (w) => w.balanceXlm !== null && w.balanceXlm < thresholdXlm,
      ).length,
    };
  }

  private async raiseAlerts(snap: GasReserveSnapshot): Promise<void> {
    if (!this.deps.alert) return;
    const now = this.nowMs();

    for (const pool of [snap.emergency, snap.standard]) {
      for (const wallet of pool.wallets) {
        if (wallet.balanceXlm === null || wallet.balanceXlm >= pool.thresholdXlm) {
          continue;
        }
        const last = this.lastAlertAt.get(wallet.publicKey);
        if (last !== undefined && now - last < this.config.alertIntervalMs) {
          continue;
        }
        this.lastAlertAt.set(wallet.publicKey, now);
        try {
          await this.deps.alert({
            pool: pool.pool,
            publicKey: wallet.publicKey,
            balanceXlm: wallet.balanceXlm,
            thresholdXlm: pool.thresholdXlm,
            timestamp: new Date(now),
          });
        } catch (err) {
          // A failed alert must not break allocation; retry on the next check.
          this.lastAlertAt.delete(wallet.publicKey);
          logger.error("[GasReserve] Failed to send low-balance alert:", err);
        }
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.timer) return;
    await this.refresh().catch((err) => {
      logger.error("[GasReserve] Initial balance check failed:", err);
    });
    this.timer = setInterval(() => {
      this.refresh().catch((err) => {
        logger.error("[GasReserve] Balance check failed:", err);
      });
    }, this.config.checkIntervalMs);
    // Never keep the process alive just for monitoring.
    this.timer.unref?.();
    logger.info(
      `[GasReserve] Monitoring started (every ${this.config.checkIntervalMs}ms)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ─── Production wiring ────────────────────────────────────────────────────────

function envNumber(name: string, fallback: number): number {
  const parsed = parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Config from RELAYER_GAS_* environment variables, with safe defaults. */
export function gasReserveConfigFromEnv(): Partial<RelayerGasReserveConfig> {
  const d = DEFAULT_GAS_RESERVE_CONFIG;
  return {
    reserveRatio: envNumber("RELAYER_GAS_RESERVE_RATIO", d.reserveRatio),
    minOperatingBalanceXlm: envNumber("RELAYER_GAS_MIN_OPERATING_XLM", d.minOperatingBalanceXlm),
    standardAlertThresholdXlm: envNumber("RELAYER_GAS_STANDARD_THRESHOLD_XLM", d.standardAlertThresholdXlm),
    emergencyAlertThresholdXlm: envNumber("RELAYER_GAS_EMERGENCY_THRESHOLD_XLM", d.emergencyAlertThresholdXlm),
    checkIntervalMs: envNumber("RELAYER_GAS_CHECK_INTERVAL_MS", d.checkIntervalMs),
  };
}

let _instance: RelayerGasReserveAllocator | null = null;

/**
 * Lazy singleton wired to the Relayer table, Horizon and the ops webhook.
 * Imports are deferred so merely importing this module never opens a database
 * connection or reads Stellar configuration.
 */
export async function getRelayerGasReserveAllocator(): Promise<RelayerGasReserveAllocator> {
  if (_instance) return _instance;

  const [{ default: prisma }, { default: stellarProvider }, { getWebhookService }] =
    await Promise.all([
      import("../lib/prisma"),
      import("../lib/stellarProvider"),
      import("./webhook"),
    ]);

  _instance = new RelayerGasReserveAllocator(
    {
      async listWallets() {
        const relayers = await prisma.relayer.findMany({
          where: { isActive: true, publicKey: { not: null } },
          select: { id: true, publicKey: true },
          orderBy: { id: "asc" },
        });
        return relayers.map((r) => ({ id: r.id, publicKey: r.publicKey! }));
      },
      async fetchBalanceXlm(publicKey) {
        try {
          const account = await stellarProvider.getServer().loadAccount(publicKey);
          const native = account.balances.find((b) => b.asset_type === "native");
          return native ? parseFloat(native.balance) : 0;
        } catch (err) {
          // An unfunded account is a legitimate zero, not a lookup failure.
          if ((err as { response?: { status?: number } })?.response?.status === 404) {
            return 0;
          }
          throw err;
        }
      },
      async alert(a) {
        await getWebhookService().sendGasBalanceAlert({
          currentBalance: a.balanceXlm,
          threshold: a.thresholdXlm,
          walletAddress: a.publicKey,
          poolLabel: a.pool === "EMERGENCY" ? "Emergency reserve" : "Standard pool",
          timestamp: a.timestamp,
        });
      },
    },
    gasReserveConfigFromEnv(),
  );
  return _instance;
}
