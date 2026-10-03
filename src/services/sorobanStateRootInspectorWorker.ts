import axios from "axios";
import { xdr } from "@stellar/stellar-sdk";
import { getRedisClient } from "../lib/redis";
import stellarProvider from "../lib/stellarProvider";
import { logger } from "../utils/logger";

/**
 * Issue #1067 – Soroban State Proof Merkle Tree Root Inspector Worker.
 *
 * Continuously verifies the off-chain Merkle tree state against the official
 * Soroban ledger state root:
 *
 * 1. Fetch the current ledger header from Soroban RPC and extract the ledger
 *    state root (the bucket-list hash committed in the header).
 * 2. Compare it with the locally persisted state root.
 * 3. Raise a security alert whenever the two roots diverge.
 */

export const STATE_ROOT_INSPECTION_INTERVAL_MS = Number(
  process.env.STATE_ROOT_INSPECTION_INTERVAL_MS ?? 300_000,
);

export const LOCAL_STATE_ROOT_REDIS_KEY = "stellarflow:state:root";
const MERKLE_ROOT_ORDER_KEY = "stellarflow:zk:merkle-roots:order";

export interface LedgerStateRoot {
  stateRoot: string;
  ledgerSequence: number;
  protocolVersion?: number;
  closeTime?: number;
}

export interface StateRootInspection {
  matched: boolean;
  networkStateRoot: string | null;
  localStateRoot: string | null;
  ledgerSequence: number | null;
  inspectedAt: string;
  reason?:
    | "MATCH"
    | "ROOT_MISMATCH"
    | "LOCAL_STATE_UNAVAILABLE"
    | "NETWORK_STATE_UNAVAILABLE";
  error?: string;
}

export interface SecurityAlert {
  type: "state_root_mismatch";
  severity: "critical";
  title: string;
  message: string;
  networkStateRoot: string | null;
  localStateRoot: string | null;
  ledgerSequence: number | null;
  timestamp: string;
}

export type SecurityAlertSink = (alert: SecurityAlert) => void | Promise<void>;

export interface StateRootInspectorDeps {
  fetchNetworkStateRoot?: () => Promise<LedgerStateRoot>;
  getLocalStateRoot?: () => Promise<string | null>;
  alertSink?: SecurityAlertSink;
  intervalMs?: number;
  now?: () => Date;
}

function normalizeRoot(root: string | null | undefined): string | null {
  if (!root) return null;
  const trimmed = root.trim().toLowerCase().replace(/^0x/, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * Decode the ledger state root from a Soroban RPC `headerXdr` value. The
 * bucket-list hash is the canonical commitment of the ledger state.
 */
export function extractLedgerStateRoot(
  headerXdr: string,
  format: "base64" | "hex" = "base64",
): string {
  const header = xdr.LedgerHeader.fromXDR(Buffer.from(headerXdr, format));
  const hash = header.bucketListHash() as unknown as Buffer;
  return Buffer.from(hash).toString("hex");
}

async function fetchNetworkStateRoot(): Promise<LedgerStateRoot> {
  const rpc = stellarProvider.getRpcServer();
  const latest = await rpc.getLatestLedger();
  const headerXdr = (latest as unknown as { headerXdr?: string }).headerXdr;
  if (!headerXdr) {
    throw new Error("Soroban RPC getLatestLedger response is missing headerXdr");
  }
  const response: LedgerStateRoot = {
    stateRoot: extractLedgerStateRoot(headerXdr, "base64"),
    ledgerSequence: Number(latest.sequence),
    protocolVersion: Number(latest.protocolVersion),
  };
  const closeTime = (latest as unknown as { closeTime?: number }).closeTime;
  if (typeof closeTime === "number") response.closeTime = closeTime;
  return response;
}

async function getLocalStateRoot(): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return null;

  const explicit = await redis.get(LOCAL_STATE_ROOT_REDIS_KEY);
  if (explicit) return explicit;

  const latest = await redis.zRange(MERKLE_ROOT_ORDER_KEY, -1, -1);
  return latest[0] ?? null;
}

const defaultAlertSink: SecurityAlertSink = async (alert) => {
  logger.error(`[StateRootInspector] SECURITY ALERT: ${alert.message}`);
  const webhook =
    process.env.SECURITY_ALERT_WEBHOOK_URL ?? process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;
  try {
    await axios.post(webhook, {
      content: alert.message,
      title: alert.title,
      severity: alert.severity,
      networkStateRoot: alert.networkStateRoot,
      localStateRoot: alert.localStateRoot,
      ledgerSequence: alert.ledgerSequence,
      timestamp: alert.timestamp,
    });
  } catch (error) {
    logger.warn(
      `[StateRootInspector] Failed to deliver security alert: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

export class SorobanStateRootInspectorWorker {
  private readonly fetchNetwork: () => Promise<LedgerStateRoot>;
  private readonly getLocal: () => Promise<string | null>;
  private readonly alertSink: SecurityAlertSink;
  private readonly intervalMs: number;
  private readonly now: () => Date;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastInspection: StateRootInspection | null = null;
  private lastHeartbeatAt: number | null = null;

  constructor(deps: StateRootInspectorDeps = {}) {
    this.fetchNetwork = deps.fetchNetworkStateRoot ?? fetchNetworkStateRoot;
    this.getLocal = deps.getLocalStateRoot ?? getLocalStateRoot;
    this.alertSink = deps.alertSink ?? defaultAlertSink;
    this.intervalMs = deps.intervalMs ?? STATE_ROOT_INSPECTION_INTERVAL_MS;
    this.now = deps.now ?? (() => new Date());
  }

  async inspectOnce(): Promise<StateRootInspection> {
    const inspectedAt = this.now().toISOString();
    let network: LedgerStateRoot | null = null;
    let error: string | undefined;

    try {
      network = await this.fetchNetwork();
    } catch (fetchError) {
      error = fetchError instanceof Error ? fetchError.message : String(fetchError);
    }

    let localRoot: string | null = null;
    try {
      localRoot = await this.getLocal();
    } catch (localError) {
      logger.warn(
        `[StateRootInspector] Failed to read local state root: ${
          localError instanceof Error ? localError.message : String(localError)
        }`,
      );
    }

    const networkRoot = normalizeRoot(network?.stateRoot ?? null);
    const normalizedLocal = normalizeRoot(localRoot);

    const inspection = this.buildInspection(
      network,
      networkRoot,
      normalizedLocal,
      inspectedAt,
      error,
    );

    this.lastInspection = inspection;
    this.lastHeartbeatAt = this.now().getTime();

    if (!inspection.matched && inspection.reason === "ROOT_MISMATCH") {
      await this.raiseAlert(inspection);
    }

    return inspection;
  }

  private buildInspection(
    network: LedgerStateRoot | null,
    networkRoot: string | null,
    localRoot: string | null,
    inspectedAt: string,
    error: string | undefined,
  ): StateRootInspection {
    if (!networkRoot) {
      const inspection: StateRootInspection = {
        matched: false,
        networkStateRoot: null,
        localStateRoot: localRoot,
        ledgerSequence: network?.ledgerSequence ?? null,
        inspectedAt,
        reason: "NETWORK_STATE_UNAVAILABLE",
      };
      if (error !== undefined) inspection.error = error;
      return inspection;
    }

    if (!localRoot) {
      return {
        matched: false,
        networkStateRoot: networkRoot,
        localStateRoot: null,
        ledgerSequence: network?.ledgerSequence ?? null,
        inspectedAt,
        reason: "LOCAL_STATE_UNAVAILABLE",
      };
    }

    const matched = networkRoot === localRoot;
    return {
      matched,
      networkStateRoot: networkRoot,
      localStateRoot: localRoot,
      ledgerSequence: network?.ledgerSequence ?? null,
      inspectedAt,
      reason: matched ? "MATCH" : "ROOT_MISMATCH",
    };
  }

  private async raiseAlert(inspection: StateRootInspection): Promise<void> {
    const alert: SecurityAlert = {
      type: "state_root_mismatch",
      severity: "critical",
      title: "Soroban state root mismatch",
      message: `Off-chain Merkle state root ${inspection.localStateRoot} does not match Soroban ledger state root ${inspection.networkStateRoot} at ledger ${inspection.ledgerSequence}`,
      networkStateRoot: inspection.networkStateRoot,
      localStateRoot: inspection.localStateRoot,
      ledgerSequence: inspection.ledgerSequence,
      timestamp: inspection.inspectedAt,
    };
    await this.alertSink(alert);
  }

  start(): void {
    if (this.timer) return;
    void this.inspectOnce().catch((error) => {
      logger.error("[StateRootInspector] Initial inspection failed", error);
    });
    this.timer = setInterval(() => {
      void this.inspectOnce().catch((error) => {
        logger.error("[StateRootInspector] Inspection failed", error);
      });
    }, this.intervalMs);
    this.timer.unref?.();
    logger.info(
      `[StateRootInspector] Started with ${this.intervalMs}ms interval`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  getLastInspection(): StateRootInspection | null {
    return this.lastInspection;
  }

  getLastHeartbeatAt(): number | null {
    return this.lastHeartbeatAt;
  }

  getHeartbeatTimeoutMs(): number {
    return this.intervalMs * 3;
  }
}

export const sorobanStateRootInspectorWorker =
  new SorobanStateRootInspectorWorker();
