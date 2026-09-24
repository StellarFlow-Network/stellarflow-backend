/**
 * GovernanceTimelockService
 *
 * Responsibilities:
 *   1. Index ProposalQueued and TimelockActionExecuted Soroban contract events
 *      via the Soroban RPC `getEvents` API into the database.
 *   2. On every poll tick, detect proposals whose timelock execution window has
 *      expired but have not yet been notified, then fire a notification and
 *      increment notificationCount / set executionReadyNotifiedAt.
 *   3. Continue the existing behaviour: execute proposals that are past their
 *      expiresAt date against the Stellar network.
 */
import prisma from "../lib/prisma";
import stellarProvider from "../lib/stellarProvider";
import { StellarService } from "./stellarService";
import { notificationService } from "./notificationService";
import { governanceWebhookBroadcaster } from "./governanceWebhookBroadcaster";
import { logger } from "../utils/logger";
import { xdr } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TimelockedProposal {
  id: number;
  proposalId: string;
  contractId: string;
  expiresAt: Date;
}

interface PendingNotification {
  id: number;
  proposalId: string;
  contractId: string;
  expiresAt: Date;
  notificationCount: number;
}

interface RawSorobanEvent {
  id?: string;
  type?: string;
  ledger?: number | string;
  ledgerClosedAt?: string;
  contractId?: string;
  txHash?: string;
  topic?: unknown;
  value?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers: XDR / ScVal decoding
// ---------------------------------------------------------------------------

function decodeScVal(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    const scVal = xdr.ScVal.fromXDR(raw, "base64") as any;
    const typeName: string = scVal.switch().name;
    if (typeName === "scvSymbol" || typeName === "scvString") {
      return scVal.value().toString();
    }
    if (["scvU64", "scvI64", "scvU32", "scvI32"].includes(typeName)) {
      return scVal.value().toString();
    }
    if (typeName === "scvMap") {
      return Object.fromEntries(
        ((scVal.map() as any[]) ?? []).map((entry: any) => [
          String(decodeScVal(entry.key())),
          decodeScVal(entry.val()),
        ]),
      );
    }
  } catch {
    // Return raw string if decoding fails
  }
  return raw;
}

/** Decode the first topic element of a Soroban event to identify its type. */
function extractEventName(topic: unknown): string | null {
  if (Array.isArray(topic)) {
    const first = topic[0];
    const decoded = decodeScVal(first);
    return typeof decoded === "string" ? decoded : null;
  }
  if (typeof topic === "string") {
    const decoded = decodeScVal(topic);
    return typeof decoded === "string" ? decoded : null;
  }
  return null;
}

/** Extract proposalId from event topics or value payload. */
function extractProposalId(topic: unknown, value: unknown): string | null {
  // Try topics[1] first (common convention: [eventName, proposalId, ...])
  if (Array.isArray(topic) && topic.length >= 2) {
    const decoded = decodeScVal(topic[1]);
    if (typeof decoded === "string" && decoded.length > 0) return decoded;
  }
  // Fall back to value map
  const decoded = decodeScVal(value) as Record<string, unknown> | null;
  if (decoded && typeof decoded === "object") {
    const pid =
      decoded["proposalId"] ?? decoded["proposal_id"] ?? decoded["id"];
    if (typeof pid === "string") return pid;
  }
  return null;
}

/** Extract expiresAt from the value payload of a ProposalQueued event. */
function extractExpiresAt(value: unknown): Date | null {
  const decoded = decodeScVal(value) as Record<string, unknown> | null;
  if (!decoded || typeof decoded !== "object") return null;

  const raw =
    decoded["expiresAt"] ??
    decoded["expires_at"] ??
    decoded["eta"] ??
    decoded["executeAfter"] ??
    decoded["execute_after"];

  if (!raw) return null;

  // Could be a Unix timestamp (seconds or ms) or an ISO string
  if (typeof raw === "string") {
    const num = Number(raw);
    if (!isNaN(num)) {
      // Heuristic: Stellar ledger timestamps are in seconds
      return new Date(num < 1e12 ? num * 1000 : num);
    }
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === "number") {
    return new Date(raw < 1e12 ? raw * 1000 : raw);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GovernanceTimelockService {
  private readonly pollIntervalMs: number;
  private readonly stellarService: StellarService;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Tracks the highest ledger sequence we have already indexed. */
  private lastIndexedLedger = 0;

  constructor(
    pollIntervalMs = Number(process.env.GOVERNANCE_POLL_INTERVAL_MS) || 15_000,
    stellarService = new StellarService(),
    private readonly webhookBroadcaster = governanceWebhookBroadcaster,
  ) {
    this.pollIntervalMs = pollIntervalMs;
    this.stellarService = stellarService;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Resume from the last ledger we indexed so we do not re-process events.
    const latestEvent = await prisma.timelockEvent.findFirst({
      orderBy: { ledgerSeq: "desc" },
    });
    if (latestEvent) {
      this.lastIndexedLedger = latestEvent.ledgerSeq;
    }

    await this.tick();
    this.timer = setInterval(() => {
      this.tick().catch((err) =>
        logger.error("[GovernanceTimelockService] Poll error:", err),
      );
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  // -------------------------------------------------------------------------
  // Main poll tick
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    const contractId =
      process.env.GOVERNANCE_CONTRACT_ID ?? process.env.CONTRACT_ID;
    if (!contractId) return;

    await this.indexContractEvents(contractId);
    await this.notifyReadyProposals();
    await this.checkAndExecute(contractId);
  }

  // -------------------------------------------------------------------------
  // Task 3 – Index ProposalQueued and TimelockActionExecuted events
  // -------------------------------------------------------------------------

  async indexContractEvents(contractId: string): Promise<void> {
    try {
      const rpc = stellarProvider.getRpcServer() as any;
      const startLedger = Math.max(1, this.lastIndexedLedger);

      const response = await rpc.getEvents({
        startLedger,
        filters: [{ type: "contract", contractIds: [contractId] }],
        limit: 200,
      });

      const events: RawSorobanEvent[] = response?.events ?? [];

      for (const event of events) {
        const eventName = extractEventName(event.topic);
        if (
          eventName !== "ProposalQueued" &&
          eventName !== "TimelockActionExecuted"
        ) {
          // Update cursor even for irrelevant events so we don't re-scan them
          const ledger = Number(event.ledger ?? 0);
          if (ledger > this.lastIndexedLedger) this.lastIndexedLedger = ledger;
          continue;
        }

        const proposalId = extractProposalId(event.topic, event.value);
        if (!proposalId) {
          logger.warn(
            `[GovernanceTimelockService] Could not extract proposalId from ${eventName} event`,
          );
          continue;
        }

        const txHash = String(event.txHash ?? "");
        const ledgerSeq = Number(event.ledger ?? 0);
        const topicsJson = JSON.stringify(event.topic ?? null);
        const valueJson = JSON.stringify(event.value ?? null);

        // Upsert the raw event row (idempotent)
        await prisma.timelockEvent.upsert({
          where: {
            txHash_eventType_proposalId: {
              txHash,
              eventType: eventName,
              proposalId,
            },
          },
          create: {
            eventType: eventName,
            proposalId,
            contractId,
            ledgerSeq,
            txHash,
            topics: topicsJson,
            value: valueJson,
          },
          update: {
            // Re-index ledgerSeq in case it was wrong (shouldn't happen, but be safe)
            ledgerSeq,
          },
        });

        if (eventName === "ProposalQueued") {
          await this.handleProposalQueued(
            proposalId,
            contractId,
            event,
            txHash,
          );
        } else if (eventName === "TimelockActionExecuted") {
          await this.handleTimelockActionExecuted(
            proposalId,
            event.contractId ?? contractId,
          );
        }

        if (ledgerSeq > this.lastIndexedLedger) {
          this.lastIndexedLedger = ledgerSeq;
        }
      }
    } catch (err) {
      logger.error(
        "[GovernanceTimelockService] Failed to index contract events:",
        err,
      );
    }
  }

  /** Upsert a GovernanceProposal row from a ProposalQueued event. */
  private async handleProposalQueued(
    proposalId: string,
    contractId: string,
    event: RawSorobanEvent,
    txHash: string,
  ): Promise<void> {
    const expiresAt = extractExpiresAt(event.value);
    const ledgerClosedAt = event.ledgerClosedAt
      ? new Date(event.ledgerClosedAt)
      : new Date();

    // Default execution window: 24 h from when the event was indexed, if the
    // chain payload does not carry an explicit expiry.
    const effectiveExpiresAt =
      expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.governanceProposal.upsert({
      where: { proposalId },
      create: {
        proposalId,
        contractId,
        status: "Queued",
        expiresAt: effectiveExpiresAt,
        queuedAt: ledgerClosedAt,
        timelockActionSource: txHash,
        notificationCount: 0,
      },
      update: {
        // Only update immutable fields on the initial queue insertion;
        // do not overwrite status or notification tracking if already present.
        queuedAt: ledgerClosedAt,
        timelockActionSource: txHash,
        expiresAt: effectiveExpiresAt,
        updatedAt: new Date(),
      },
    });

    logger.info(
      `[GovernanceTimelockService] Indexed ProposalQueued: ${proposalId} (expires ${effectiveExpiresAt.toISOString()})`,
    );
  }

  /** Mark a GovernanceProposal as Executed when its TimelockActionExecuted event arrives. */
  private async handleTimelockActionExecuted(
    proposalId: string,
    contractId?: string,
  ): Promise<void> {
    const executedAt = new Date();

    await prisma.governanceProposal
      .update({
        where: { proposalId },
        data: {
          status: "Executed",
          executedAt,
          updatedAt: executedAt,
        },
      })
      .catch((err: unknown) => {
        // Proposal row might not exist if we missed the ProposalQueued event —
        // log and continue rather than crashing.
        logger.warn(
          `[GovernanceTimelockService] Could not mark ${proposalId} Executed (row may not exist):`,
          err,
        );
      });

    void this.webhookBroadcaster
      .broadcastProposalExecuted({
        proposalId,
        contractId: contractId ?? null,
        status: "Executed",
        executedAt,
      })
      .catch((err) => {
        logger.warn(
          `[GovernanceTimelockService] Webhook broadcast failed for ${proposalId}:`,
          err,
        );
      });

    logger.info(
      `[GovernanceTimelockService] Indexed TimelockActionExecuted: ${proposalId}`,
    );
  }

  // -------------------------------------------------------------------------
  // Task 4 – Fire execution-ready notifications
  // -------------------------------------------------------------------------

  async notifyReadyProposals(): Promise<void> {
    const now = new Date();

    // Find queued proposals whose timelock window has passed and that have
    // not yet been notified (or need a follow-up notification).
    const pending = await prisma.$queryRaw<PendingNotification[]>`
      SELECT "id", "proposalId", "contractId", "expiresAt", "notificationCount"
      FROM "GovernanceProposal"
      WHERE "status" = 'Queued'
        AND "expiresAt" <= ${now}
        AND "executionReadyNotifiedAt" IS NULL
      ORDER BY "expiresAt" ASC
    `;

    for (const proposal of pending) {
      try {
        await notificationService.sendGovernanceTimelockReadyAlert({
          proposalId: proposal.proposalId,
          contractId: proposal.contractId,
          expiresAt: proposal.expiresAt,
        });

        await prisma.$executeRaw`
          UPDATE "GovernanceProposal"
          SET
            "notificationCount"        = "notificationCount" + 1,
            "executionReadyNotifiedAt" = NOW(),
            "updatedAt"                = NOW()
          WHERE "id" = ${proposal.id}
        `;

        void this.webhookBroadcaster
          .broadcastProposalExpired({
            proposalId: proposal.proposalId,
            contractId: proposal.contractId,
            status: "Queued",
            expiresAt: proposal.expiresAt,
            reason: "timelock_expired",
          })
          .catch((err) => {
            logger.warn(
              `[GovernanceTimelockService] Webhook broadcast failed for ${proposal.proposalId}:`,
              err,
            );
          });

        logger.info(
          `[GovernanceTimelockService] Notified ready proposal: ${proposal.proposalId}`,
        );
      } catch (err) {
        logger.error(
          `[GovernanceTimelockService] Notification failed for ${proposal.proposalId}:`,
          err,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Existing behaviour: on-chain execution of expired proposals
  // -------------------------------------------------------------------------

  private async checkAndExecute(contractId: string): Promise<void> {
    const ledger = await stellarProvider
      .getServer()
      .ledgers()
      .order("desc")
      .limit(1)
      .call();
    const ledgerTimestamp = new Date(ledger.records[0]!.closed_at);

    const proposals = await prisma.$queryRaw<TimelockedProposal[]>`
      SELECT "id", "proposalId", "contractId", "expiresAt"
      FROM "GovernanceProposal"
      WHERE "status" = 'Queued' AND "expiresAt" <= ${ledgerTimestamp}
      ORDER BY "expiresAt" ASC
    `;

    for (const proposal of proposals) {
      try {
        const transactionHash =
          await this.stellarService.executeGovernanceProposal(
            proposal.contractId || contractId,
            proposal.proposalId,
          );
        await prisma.$executeRaw`
          UPDATE "GovernanceProposal"
          SET "status" = 'Executed', "transactionHash" = ${transactionHash}, "executedAt" = NOW(), "updatedAt" = NOW()
          WHERE "id" = ${proposal.id} AND "status" = 'Queued'
        `;

        void this.webhookBroadcaster
          .broadcastProposalExecuted({
            proposalId: proposal.proposalId,
            contractId: proposal.contractId,
            status: "Executed",
            transactionHash,
            expiresAt: proposal.expiresAt,
            executedAt: new Date(),
          })
          .catch((err) => {
            logger.warn(
              `[GovernanceTimelockService] Webhook broadcast failed for ${proposal.proposalId}:`,
              err,
            );
          });
      } catch (err) {
        logger.error(
          `[GovernanceTimelockService] Failed to execute proposal ${proposal.proposalId}:`,
          err,
        );
      }
    }
  }
}

export const governanceTimelockService = new GovernanceTimelockService();
