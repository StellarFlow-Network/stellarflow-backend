import {
  nativeToScVal,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import prisma from "../lib/prisma";
import { getRedisClient } from "../lib/redis";
import { broadcastToSessions } from "../lib/socket";
import stellarProvider from "../lib/stellarProvider";
import { logger } from "../utils/logger";
import {
  AlertSeverity,
  AlertType,
  NotificationService,
  type SystemAlert,
} from "./notificationService";

export type ReserveScalar = string | number | bigint | { toString(): string };

export type SorobanStorageKeyFormat =
  | "auto"
  | "symbol"
  | "string"
  | "hex"
  | "base64"
  | "u32"
  | "u64"
  | "i128"
  | "u128";

export interface DatabasePoolReserveRecord {
  poolAddress: string;
  contractId: string;
  reserveA: ReserveScalar;
  reserveB: ReserveScalar;
  reserveAStorageKey: string;
  reserveBStorageKey: string;
  reserveAStorageKeyFormat?: SorobanStorageKeyFormat;
  reserveBStorageKeyFormat?: SorobanStorageKeyFormat;
  reserveScale?: number;
  reserveAScale?: number;
  reserveBScale?: number;
  lastSyncedLedger?: number | null;
}

export interface ContractPoolReserveState {
  poolAddress: string;
  contractId: string;
  ledgerSeq: number;
  reserveA: bigint;
  reserveB: bigint;
  observedAt: string;
}

export interface AmmReserveDivergence {
  poolAddress: string;
  contractId: string;
  ledgerSeq: number;
  databaseReserveA: string;
  databaseReserveB: string;
  contractReserveA: string;
  contractReserveB: string;
  deltaA: string;
  deltaB: string;
  observedAt: string;
  action: "database_resync_triggered";
}

export interface PoolReserveStore {
  listTrackedPools(): Promise<DatabasePoolReserveRecord[]>;
  resyncPoolReserves(
    pool: DatabasePoolReserveRecord,
    liveState: ContractPoolReserveState,
  ): Promise<void>;
}

export interface ContractReserveReader {
  getLatestLedgerSequence(): Promise<number>;
  getPoolReserves(
    pool: DatabasePoolReserveRecord,
    ledgerSeq: number,
  ): Promise<ContractPoolReserveState>;
}

export interface AmmReserveDivergenceDetectorConfig {
  intervalLedgers?: number;
  pollIntervalMs?: number;
}

export interface NotificationClient {
  sendAlert(alert: SystemAlert): Promise<boolean>;
}

interface RawPoolReserveRow {
  poolAddress: unknown;
  contractId: unknown;
  reserveA: unknown;
  reserveB: unknown;
  reserveAStorageKey: unknown;
  reserveBStorageKey: unknown;
  reserveAStorageKeyFormat?: unknown;
  reserveBStorageKeyFormat?: unknown;
  reserveScale?: unknown;
  reserveAScale?: unknown;
  reserveBScale?: unknown;
  lastSyncedLedger?: unknown;
}

const DEFAULT_INTERVAL_LEDGERS = 50;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_RESERVE_TABLE = "amm_pool_reserves";
const DEFAULT_LIMIT = 500;

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeScale(value: unknown, field: string): number {
  const scale = Number(value ?? 0);
  if (!Number.isInteger(scale) || scale < 0 || scale > 30) {
    throw new Error(`${field} must be an integer between 0 and 30`);
  }
  return scale;
}

function reserveScaleFor(
  pool: DatabasePoolReserveRecord,
  side: "A" | "B",
): number {
  return normalizeScale(
    side === "A"
      ? (pool.reserveAScale ?? pool.reserveScale ?? 0)
      : (pool.reserveBScale ?? pool.reserveScale ?? 0),
    `reserve${side}Scale`,
  );
}

function pow10(scale: number): bigint {
  return 10n ** BigInt(scale);
}

export function reserveScalarToBigInt(
  value: ReserveScalar,
  field: string,
  scale = 0,
): bigint {
  const normalizedScale = normalizeScale(scale, `${field} scale`);
  const raw = String(value).trim();
  if (!raw) throw new Error(`${field} is empty`);

  let parsed: bigint;
  if (/^[+-]?\d+$/.test(raw)) {
    parsed = BigInt(raw) * pow10(normalizedScale);
  } else {
    const match = raw.match(/^([+-]?\d+)\.(\d+)$/);
    if (!match) {
      throw new Error(`${field} must be an integer reserve amount`);
    }

    const wholePart = match[1] ?? "0";
    const fractionalPart = match[2] ?? "";
    const excessFraction = fractionalPart.slice(normalizedScale);
    if (/[1-9]/.test(excessFraction)) {
      throw new Error(
        `${field} has more precision than scale ${normalizedScale}`,
      );
    }

    const sign = wholePart.startsWith("-") ? -1n : 1n;
    const absoluteWhole = wholePart.replace(/^[+-]/, "") || "0";
    const normalizedFraction = fractionalPart
      .slice(0, normalizedScale)
      .padEnd(normalizedScale, "0");
    parsed = sign * BigInt(`${absoluteWhole}${normalizedFraction || ""}`);
  }

  if (parsed < 0n) throw new Error(`${field} must be non-negative`);
  return parsed;
}

function formatReserveForDatabase(amount: bigint, scale: number): string {
  const normalizedScale = normalizeScale(scale, "reserve scale");
  if (amount < 0n) throw new Error("reserve amount must be non-negative");
  if (normalizedScale === 0) return amount.toString();

  const divisor = pow10(normalizedScale);
  const whole = amount / divisor;
  const fractional = (amount % divisor)
    .toString()
    .padStart(normalizedScale, "0");
  return `${whole}.${fractional}`;
}

function normalizeStorageKeyFormat(
  value: unknown,
): SorobanStorageKeyFormat | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).toLowerCase();
  const allowed = new Set<SorobanStorageKeyFormat>([
    "auto",
    "symbol",
    "string",
    "hex",
    "base64",
    "u32",
    "u64",
    "i128",
    "u128",
  ]);
  if (!allowed.has(text as SorobanStorageKeyFormat)) {
    throw new Error(`Unsupported Soroban storage key format: ${value}`);
  }
  return text as SorobanStorageKeyFormat;
}

function quoteSqlIdentifierPath(identifier: string): string {
  const parts = identifier.split(".");
  if (
    parts.length === 0 ||
    parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
  ) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return parts.map((part) => `"${part}"`).join(".");
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  return requirePositiveInteger(Number(raw), name);
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rowToReserveRecord(row: RawPoolReserveRow): DatabasePoolReserveRecord {
  const reserveAStorageKeyFormat = normalizeStorageKeyFormat(
    row.reserveAStorageKeyFormat,
  );
  const reserveBStorageKeyFormat = normalizeStorageKeyFormat(
    row.reserveBStorageKeyFormat,
  );
  const reserveAScale = normalizeOptionalNumber(row.reserveAScale);
  const reserveBScale = normalizeOptionalNumber(row.reserveBScale);
  const reserveScale = normalizeOptionalNumber(row.reserveScale);
  const lastSyncedLedger = normalizeOptionalNumber(row.lastSyncedLedger);
  const record: DatabasePoolReserveRecord = {
    poolAddress: String(row.poolAddress),
    contractId: String(row.contractId),
    reserveA: String(row.reserveA),
    reserveB: String(row.reserveB),
    reserveAStorageKey: String(row.reserveAStorageKey),
    reserveBStorageKey: String(row.reserveBStorageKey),
  };

  if (reserveAStorageKeyFormat) {
    record.reserveAStorageKeyFormat = reserveAStorageKeyFormat;
  }
  if (reserveBStorageKeyFormat) {
    record.reserveBStorageKeyFormat = reserveBStorageKeyFormat;
  }
  if (reserveScale !== undefined) record.reserveScale = reserveScale;
  if (reserveAScale !== undefined) record.reserveAScale = reserveAScale;
  if (reserveBScale !== undefined) record.reserveBScale = reserveBScale;
  if (lastSyncedLedger !== undefined)
    record.lastSyncedLedger = lastSyncedLedger;

  return record;
}

export interface PrismaAmmReserveStoreOptions {
  tableName?: string;
  poolAddressColumn?: string;
  contractIdColumn?: string;
  reserveAColumn?: string;
  reserveBColumn?: string;
  reserveAStorageKeyColumn?: string;
  reserveBStorageKeyColumn?: string;
  reserveAStorageKeyFormatColumn?: string;
  reserveBStorageKeyFormatColumn?: string;
  reserveScaleColumn?: string;
  reserveAScaleColumn?: string;
  reserveBScaleColumn?: string;
  ledgerSeqColumn?: string;
  updatedAtColumn?: string;
  activeColumn?: string;
  limit?: number;
}

export class PrismaAmmReserveStore implements PoolReserveStore {
  private readonly tableName: string;
  private readonly poolAddressColumn: string;
  private readonly contractIdColumn: string;
  private readonly reserveAColumn: string;
  private readonly reserveBColumn: string;
  private readonly reserveAStorageKeyColumn: string;
  private readonly reserveBStorageKeyColumn: string;
  private readonly reserveAStorageKeyFormatColumn: string | undefined;
  private readonly reserveBStorageKeyFormatColumn: string | undefined;
  private readonly reserveScaleColumn: string | undefined;
  private readonly reserveAScaleColumn: string | undefined;
  private readonly reserveBScaleColumn: string | undefined;
  private readonly ledgerSeqColumn: string;
  private readonly updatedAtColumn: string;
  private readonly activeColumn: string | undefined;
  private readonly limit: number;

  constructor(
    private readonly client: typeof prisma = prisma,
    options: PrismaAmmReserveStoreOptions = {},
  ) {
    this.tableName =
      options.tableName ??
      process.env.AMM_RESERVE_DIVERGENCE_TABLE ??
      DEFAULT_RESERVE_TABLE;
    this.poolAddressColumn =
      options.poolAddressColumn ??
      process.env.AMM_RESERVE_POOL_ADDRESS_COLUMN ??
      "pool_address";
    this.contractIdColumn =
      options.contractIdColumn ??
      process.env.AMM_RESERVE_CONTRACT_ID_COLUMN ??
      "contract_id";
    this.reserveAColumn =
      options.reserveAColumn ?? process.env.AMM_RESERVE_A_COLUMN ?? "reserve_a";
    this.reserveBColumn =
      options.reserveBColumn ?? process.env.AMM_RESERVE_B_COLUMN ?? "reserve_b";
    this.reserveAStorageKeyColumn =
      options.reserveAStorageKeyColumn ??
      process.env.AMM_RESERVE_A_STORAGE_KEY_COLUMN ??
      "reserve_a_storage_key";
    this.reserveBStorageKeyColumn =
      options.reserveBStorageKeyColumn ??
      process.env.AMM_RESERVE_B_STORAGE_KEY_COLUMN ??
      "reserve_b_storage_key";
    this.reserveAStorageKeyFormatColumn =
      options.reserveAStorageKeyFormatColumn ??
      process.env.AMM_RESERVE_A_STORAGE_KEY_FORMAT_COLUMN;
    this.reserveBStorageKeyFormatColumn =
      options.reserveBStorageKeyFormatColumn ??
      process.env.AMM_RESERVE_B_STORAGE_KEY_FORMAT_COLUMN;
    this.reserveScaleColumn =
      options.reserveScaleColumn ?? process.env.AMM_RESERVE_SCALE_COLUMN;
    this.reserveAScaleColumn =
      options.reserveAScaleColumn ?? process.env.AMM_RESERVE_A_SCALE_COLUMN;
    this.reserveBScaleColumn =
      options.reserveBScaleColumn ?? process.env.AMM_RESERVE_B_SCALE_COLUMN;
    this.ledgerSeqColumn =
      options.ledgerSeqColumn ??
      process.env.AMM_RESERVE_LEDGER_SEQ_COLUMN ??
      "last_synced_ledger";
    this.updatedAtColumn =
      options.updatedAtColumn ??
      process.env.AMM_RESERVE_UPDATED_AT_COLUMN ??
      "updated_at";
    this.activeColumn =
      options.activeColumn ?? process.env.AMM_RESERVE_ACTIVE_COLUMN;
    this.limit =
      options.limit ??
      envInt("AMM_RESERVE_DIVERGENCE_POOL_LIMIT", DEFAULT_LIMIT);
  }

  async listTrackedPools(): Promise<DatabasePoolReserveRecord[]> {
    const table = quoteSqlIdentifierPath(this.tableName);
    const poolAddress = quoteSqlIdentifierPath(this.poolAddressColumn);
    const updatedAt = quoteSqlIdentifierPath(this.updatedAtColumn);
    const activeWhere = this.activeColumn
      ? `WHERE ${quoteSqlIdentifierPath(this.activeColumn)} = TRUE`
      : "";
    const reserveScaleSelect = this.reserveScaleColumn
      ? `${quoteSqlIdentifierPath(this.reserveScaleColumn)}::text`
      : "NULL";
    const reserveAScaleSelect = this.reserveAScaleColumn
      ? `${quoteSqlIdentifierPath(this.reserveAScaleColumn)}::text`
      : "NULL";
    const reserveBScaleSelect = this.reserveBScaleColumn
      ? `${quoteSqlIdentifierPath(this.reserveBScaleColumn)}::text`
      : "NULL";
    const reserveAFormatSelect = this.reserveAStorageKeyFormatColumn
      ? `${quoteSqlIdentifierPath(this.reserveAStorageKeyFormatColumn)}::text`
      : quoteSqlLiteral("auto");
    const reserveBFormatSelect = this.reserveBStorageKeyFormatColumn
      ? `${quoteSqlIdentifierPath(this.reserveBStorageKeyFormatColumn)}::text`
      : quoteSqlLiteral("auto");

    const sql = `
      SELECT DISTINCT ON (${poolAddress})
        ${poolAddress}::text AS "poolAddress",
        ${quoteSqlIdentifierPath(this.contractIdColumn)}::text AS "contractId",
        ${quoteSqlIdentifierPath(this.reserveAColumn)}::text AS "reserveA",
        ${quoteSqlIdentifierPath(this.reserveBColumn)}::text AS "reserveB",
        ${quoteSqlIdentifierPath(this.reserveAStorageKeyColumn)}::text AS "reserveAStorageKey",
        ${quoteSqlIdentifierPath(this.reserveBStorageKeyColumn)}::text AS "reserveBStorageKey",
        ${reserveAFormatSelect} AS "reserveAStorageKeyFormat",
        ${reserveBFormatSelect} AS "reserveBStorageKeyFormat",
        ${reserveScaleSelect} AS "reserveScale",
        ${reserveAScaleSelect} AS "reserveAScale",
        ${reserveBScaleSelect} AS "reserveBScale",
        ${quoteSqlIdentifierPath(this.ledgerSeqColumn)}::text AS "lastSyncedLedger"
      FROM ${table}
      ${activeWhere}
      ORDER BY ${poolAddress}, ${updatedAt} DESC
      LIMIT $1
    `;

    const rows = (await (this.client as any).$queryRawUnsafe(
      sql,
      this.limit,
    )) as RawPoolReserveRow[];
    return rows.map(rowToReserveRecord);
  }

  async resyncPoolReserves(
    pool: DatabasePoolReserveRecord,
    liveState: ContractPoolReserveState,
  ): Promise<void> {
    const table = quoteSqlIdentifierPath(this.tableName);
    const assignments = [
      `${quoteSqlIdentifierPath(this.reserveAColumn)} = $1`,
      `${quoteSqlIdentifierPath(this.reserveBColumn)} = $2`,
      `${quoteSqlIdentifierPath(this.ledgerSeqColumn)} = $3`,
      `${quoteSqlIdentifierPath(this.updatedAtColumn)} = NOW()`,
    ];
    const sql = `
      UPDATE ${table}
      SET ${assignments.join(", ")}
      WHERE ${quoteSqlIdentifierPath(this.poolAddressColumn)} = $4
    `;
    const affected = await (this.client as any).$executeRawUnsafe(
      sql,
      formatReserveForDatabase(liveState.reserveA, reserveScaleFor(pool, "A")),
      formatReserveForDatabase(liveState.reserveB, reserveScaleFor(pool, "B")),
      liveState.ledgerSeq,
      pool.poolAddress,
    );

    if (affected === 0) {
      logger.warn(
        `[AMMReserveDivergenceDetector] Resync update affected no rows for pool ${pool.poolAddress}`,
      );
    }
  }
}

export function parseSorobanStorageKey(
  rawKey: string,
  format: SorobanStorageKeyFormat = "auto",
): xdr.ScVal {
  const key = rawKey.trim();
  if (!key) throw new Error("Soroban storage key cannot be empty");

  if (format === "auto") {
    if (key.startsWith("symbol:")) {
      return parseSorobanStorageKey(key.slice("symbol:".length), "symbol");
    }
    if (key.startsWith("string:")) {
      return parseSorobanStorageKey(key.slice("string:".length), "string");
    }
    if (key.startsWith("hex:")) {
      return parseSorobanStorageKey(key.slice("hex:".length), "hex");
    }
    if (key.startsWith("base64:")) {
      return parseSorobanStorageKey(key.slice("base64:".length), "base64");
    }
    if (/^[0-9A-Fa-f]+$/.test(key) && key.length % 2 === 0) {
      try {
        return parseSorobanStorageKey(key, "hex");
      } catch {
        return xdr.ScVal.scvSymbol(key);
      }
    }
    return xdr.ScVal.scvSymbol(key);
  }

  if (format === "symbol") return xdr.ScVal.scvSymbol(key);
  if (format === "string") return nativeToScVal(key, { type: "string" });
  if (format === "hex") return xdr.ScVal.fromXDR(Buffer.from(key, "hex"));
  if (format === "base64") return xdr.ScVal.fromXDR(key, "base64");
  if (format === "u32") return nativeToScVal(Number(key), { type: "u32" });
  if (format === "u64") return nativeToScVal(BigInt(key), { type: "u64" });
  if (format === "i128") return nativeToScVal(BigInt(key), { type: "i128" });
  return nativeToScVal(BigInt(key), { type: "u128" });
}

function scValPartsToBigInt(parts: unknown, signed: boolean): bigint {
  const value = parts as {
    hi?: () => { toString(): string };
    lo?: () => { toString(): string };
  };
  if (!value.hi || !value.lo) throw new Error("invalid 128-bit parts");
  const hi = BigInt(value.hi().toString());
  const lo = BigInt(value.lo().toString());
  if (signed) return (hi << 64n) + lo;
  return (hi << 64n) + lo;
}

function contractDataValueScVal(entry: {
  val: xdr.LedgerEntryData;
}): xdr.ScVal {
  const data = entry.val.contractData();
  return data.val();
}

export function parseReserveScVal(scVal: xdr.ScVal, field: string): bigint {
  try {
    return reserveScalarToBigInt(scValToNative(scVal) as ReserveScalar, field);
  } catch {
    const value = scVal as any;
    const type = value.switch?.().name;
    if (
      ["scvU32", "scvI32", "scvU64", "scvI64"].includes(type) &&
      typeof value.value === "function"
    ) {
      return reserveScalarToBigInt(value.value(), field);
    }
    if (type === "scvI128" && typeof value.i128 === "function") {
      const amount = scValPartsToBigInt(value.i128(), true);
      if (amount < 0n) throw new Error(`${field} must be non-negative`);
      return amount;
    }
    if (type === "scvU128" && typeof value.u128 === "function") {
      return scValPartsToBigInt(value.u128(), false);
    }
    throw new Error(`${field} contract storage value is not a reserve integer`);
  }
}

export class SorobanContractReserveReader implements ContractReserveReader {
  constructor(
    private readonly rpcServer: SorobanRpc.Server = stellarProvider.getRpcServer(),
  ) {}

  async getLatestLedgerSequence(): Promise<number> {
    const latest = await this.rpcServer.getLatestLedger();
    return latest.sequence;
  }

  async getPoolReserves(
    pool: DatabasePoolReserveRecord,
    ledgerSeq: number,
  ): Promise<ContractPoolReserveState> {
    const [reserveAEntry, reserveBEntry] = await Promise.all([
      this.rpcServer.getContractData(
        pool.contractId,
        parseSorobanStorageKey(
          pool.reserveAStorageKey,
          pool.reserveAStorageKeyFormat ?? "auto",
        ),
      ),
      this.rpcServer.getContractData(
        pool.contractId,
        parseSorobanStorageKey(
          pool.reserveBStorageKey,
          pool.reserveBStorageKeyFormat ?? "auto",
        ),
      ),
    ]);

    return {
      poolAddress: pool.poolAddress,
      contractId: pool.contractId,
      ledgerSeq,
      reserveA: parseReserveScVal(
        contractDataValueScVal(reserveAEntry),
        "reserveA",
      ),
      reserveB: parseReserveScVal(
        contractDataValueScVal(reserveBEntry),
        "reserveB",
      ),
      observedAt: new Date().toISOString(),
    };
  }
}

export class AmmReserveDivergenceDetector {
  private readonly intervalLedgers: number;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private lastCheckedLedger = 0;
  private lastHeartbeatAt: number | null = null;

  constructor(
    private readonly store: PoolReserveStore,
    private readonly contractReader: ContractReserveReader,
    private readonly notifications: NotificationClient = new NotificationService(),
    config: AmmReserveDivergenceDetectorConfig = {},
  ) {
    this.intervalLedgers = requirePositiveInteger(
      config.intervalLedgers ?? DEFAULT_INTERVAL_LEDGERS,
      "AMM reserve divergence interval",
    );
    this.pollIntervalMs = requirePositiveInteger(
      config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "AMM reserve divergence poll interval",
    );
  }

  start(): void {
    if (this.timer) return;

    void this.pollLatestLedger();
    this.timer = setInterval(() => {
      void this.pollLatestLedger();
    }, this.pollIntervalMs);
    this.timer.unref();

    logger.info(
      `[AMMReserveDivergenceDetector] Started (check every ${this.intervalLedgers} ledgers)`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    logger.info("[AMMReserveDivergenceDetector] Stopped");
  }

  getLastHeartbeatAt(): number | null {
    return this.lastHeartbeatAt;
  }

  getHeartbeatTimeoutMs(): number {
    return Math.max(this.pollIntervalMs * 4, 30_000);
  }

  async onNewLedger(ledgerSeq: number): Promise<AmmReserveDivergence[]> {
    if (!Number.isInteger(ledgerSeq) || ledgerSeq <= 0) {
      throw new Error("ledgerSeq must be a positive integer");
    }
    if (this.checking) return [];
    if (ledgerSeq - this.lastCheckedLedger < this.intervalLedgers) return [];
    return this.checkAtLedger(ledgerSeq);
  }

  async checkAtLedger(ledgerSeq: number): Promise<AmmReserveDivergence[]> {
    if (this.checking) return [];
    this.checking = true;
    this.lastCheckedLedger = ledgerSeq;
    this.lastHeartbeatAt = Date.now();

    try {
      const pools = await this.store.listTrackedPools();
      if (pools.length === 0) return [];

      const results = await Promise.allSettled(
        pools.map((pool) => this.evaluatePool(pool, ledgerSeq)),
      );
      const divergences: AmmReserveDivergence[] = [];

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          divergences.push(result.value);
        } else if (result.status === "rejected") {
          logger.error(
            "[AMMReserveDivergenceDetector] Pool reserve check failed:",
            result.reason,
          );
        }
      }

      return divergences;
    } finally {
      this.checking = false;
    }
  }

  private async pollLatestLedger(): Promise<void> {
    try {
      const ledgerSeq = await this.contractReader.getLatestLedgerSequence();
      await this.onNewLedger(ledgerSeq);
    } catch (error) {
      logger.error(
        "[AMMReserveDivergenceDetector] Latest ledger poll failed:",
        error,
      );
    }
  }

  private async evaluatePool(
    pool: DatabasePoolReserveRecord,
    ledgerSeq: number,
  ): Promise<AmmReserveDivergence | null> {
    const databaseReserveA = reserveScalarToBigInt(
      pool.reserveA,
      "reserveA",
      reserveScaleFor(pool, "A"),
    );
    const databaseReserveB = reserveScalarToBigInt(
      pool.reserveB,
      "reserveB",
      reserveScaleFor(pool, "B"),
    );
    const liveState = await this.contractReader.getPoolReserves(
      pool,
      ledgerSeq,
    );
    const deltaA = liveState.reserveA - databaseReserveA;
    const deltaB = liveState.reserveB - databaseReserveB;
    if (deltaA === 0n && deltaB === 0n) return null;

    const divergence: AmmReserveDivergence = {
      poolAddress: pool.poolAddress,
      contractId: pool.contractId,
      ledgerSeq,
      databaseReserveA: databaseReserveA.toString(),
      databaseReserveB: databaseReserveB.toString(),
      contractReserveA: liveState.reserveA.toString(),
      contractReserveB: liveState.reserveB.toString(),
      deltaA: deltaA.toString(),
      deltaB: deltaB.toString(),
      observedAt: liveState.observedAt,
      action: "database_resync_triggered",
    };

    const [alertResult, resyncResult] = await Promise.allSettled([
      this.dispatchDivergence(divergence),
      this.store.resyncPoolReserves(pool, liveState),
    ]);

    if (alertResult.status === "rejected") {
      logger.error(
        "[AMMReserveDivergenceDetector] Failed to dispatch divergence alert:",
        alertResult.reason,
      );
    }
    if (resyncResult.status === "rejected") {
      logger.error(
        `[AMMReserveDivergenceDetector] Failed to resync pool ${pool.poolAddress}:`,
        resyncResult.reason,
      );
    }

    return divergence;
  }

  private async dispatchDivergence(
    divergence: AmmReserveDivergence,
  ): Promise<void> {
    broadcastToSessions("amm.reserve_divergence", divergence);

    const redis = getRedisClient();
    if (redis?.isOpen) {
      await redis.xAdd("events:amm-reserve-divergence", "*", {
        payload: JSON.stringify(divergence),
      });
    }

    await this.notifications.sendAlert({
      type: AlertType.AMM_RESERVE_DIVERGENCE,
      severity: AlertSeverity.HIGH,
      title: "AMM pool reserve divergence detected",
      message:
        `Pool ${divergence.poolAddress} reserve mismatch at ledger ${divergence.ledgerSeq}: ` +
        `deltaA=${divergence.deltaA}, deltaB=${divergence.deltaB}.`,
      details: {
        pool_address: divergence.poolAddress,
        contract_id: divergence.contractId,
        ledger_seq: divergence.ledgerSeq,
        database_reserve_a: divergence.databaseReserveA,
        database_reserve_b: divergence.databaseReserveB,
        contract_reserve_a: divergence.contractReserveA,
        contract_reserve_b: divergence.contractReserveB,
        delta_a: divergence.deltaA,
        delta_b: divergence.deltaB,
        action_required: "Automated database reserve re-sync triggered",
      },
      timestamp: new Date(divergence.observedAt),
      service: "amm-reserve-divergence-detector",
    });
  }
}

let detectorInstance: AmmReserveDivergenceDetector | undefined;

export function getAmmReserveDivergenceDetector():
  AmmReserveDivergenceDetector | undefined {
  return detectorInstance;
}

export function startAmmReserveDivergenceDetector():
  AmmReserveDivergenceDetector | undefined {
  const enabled =
    process.env.AMM_RESERVE_DIVERGENCE_ENABLED === "true" ||
    Boolean(process.env.AMM_RESERVE_DIVERGENCE_TABLE);
  if (!enabled) {
    logger.info(
      "[AMMReserveDivergenceDetector] Disabled. Set AMM_RESERVE_DIVERGENCE_ENABLED=true to start.",
    );
    return undefined;
  }

  if (!detectorInstance) {
    detectorInstance = new AmmReserveDivergenceDetector(
      new PrismaAmmReserveStore(),
      new SorobanContractReserveReader(),
    );
  }
  detectorInstance.start();
  return detectorInstance;
}
