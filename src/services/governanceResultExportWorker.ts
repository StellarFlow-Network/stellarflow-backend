/**
 * Governance Result Export Worker
 *
 * Polls PostgreSQL for governance proposals whose vote has reached a final
 * status, builds the immutable result snapshot (final tally, voter address
 * list and individual weight records), publishes it to IPFS and records the
 * returned content hash (CID) back on the proposal row.
 *
 * The snapshot is content addressed, so the stored CID is a verifiable proof
 * of the exact bytes that were exported. The proposal detail route exposes the
 * CID as a verification link.
 *
 * Follows the repository worker convention: singleton with `start()` /
 * `stop()`, an interval based poll loop and a re-entrancy guard.
 */

import prisma from "../lib/prisma";
import { logger } from "../utils/logger";
import { ipfsClient, type IpfsClient } from "./ipfsClient";
import {
  buildGovernanceResultSnapshot,
  serializeGovernanceResultSnapshot,
  sha256Hex,
  type GovernanceVoteRecord,
  type SnapshotProposalInput,
} from "./governanceResultService";

/** Proposal statuses after which the vote result can no longer change. */
export const FINAL_RESULT_STATUSES = ["Executed", "Cancelled"];

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_ATTEMPTS = 5;
const ERROR_MESSAGE_MAX_LENGTH = 500;

export interface ExportableProposalRow extends SnapshotProposalInput {
  resultExportAttempts: number;
  votes: GovernanceVoteRecord[];
}

export interface GovernanceResultStore {
  governanceProposal: {
    findMany(args: unknown): Promise<ExportableProposalRow[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
}

export interface WorkerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface GovernanceResultExportWorkerOptions {
  ipfs?: IpfsClient;
  store?: GovernanceResultStore;
  intervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  logger?: WorkerLogger;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function snapshotFilename(proposalId: string): string {
  const safeId = proposalId.replace(/[^A-Za-z0-9._-]/g, "-");
  return `${safeId}-governance-result.json`;
}

export class GovernanceResultExportWorker {
  private readonly ipfs: IpfsClient;
  private readonly store: GovernanceResultStore;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly log: WorkerLogger;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(options: GovernanceResultExportWorkerOptions = {}) {
    this.ipfs = options.ipfs ?? ipfsClient;
    this.store = options.store ?? (prisma as unknown as GovernanceResultStore);
    this.intervalMs =
      options.intervalMs ??
      Number(
        process.env.GOVERNANCE_RESULT_EXPORT_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
      );
    this.batchSize =
      options.batchSize ??
      Number(
        process.env.GOVERNANCE_RESULT_EXPORT_BATCH_SIZE ?? DEFAULT_BATCH_SIZE,
      );
    this.maxAttempts =
      options.maxAttempts ??
      Number(
        process.env.GOVERNANCE_RESULT_EXPORT_MAX_ATTEMPTS ??
          DEFAULT_MAX_ATTEMPTS,
      );
    this.log = options.logger ?? logger;
  }

  start(): void {
    if (this.timer) return;
    if (!this.ipfs.isConfigured()) {
      this.log.warn(
        "[GovernanceResultExportWorker] IPFS_API_URL is not configured; " +
          "worker stays idle. Set IPFS_API_URL to enable result exports.",
      );
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Exports one batch of completed proposals. Safe to call concurrently. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.ipfs.isConfigured()) return;

      const pending = await this.store.governanceProposal.findMany({
        where: {
          status: { in: FINAL_RESULT_STATUSES },
          resultExportCid: null,
          resultExportAttempts: { lt: this.maxAttempts },
        },
        orderBy: { updatedAt: "asc" },
        take: this.batchSize,
        include: {
          votes: { orderBy: [{ accountId: "asc" }, { votedAt: "asc" }] },
        },
      });

      for (const proposal of pending) {
        await this.exportProposal(proposal);
      }
    } catch (error) {
      this.log.error(
        `[GovernanceResultExportWorker] Export cycle failed: ${errorMessage(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Publishes a single proposal snapshot and persists its IPFS CID. */
  async exportProposal(proposal: ExportableProposalRow): Promise<void> {
    try {
      const snapshot = buildGovernanceResultSnapshot(proposal, proposal.votes);
      const content = serializeGovernanceResultSnapshot(snapshot);
      const contentHash = sha256Hex(content);

      const { cid } = await this.ipfs.add(
        content,
        snapshotFilename(proposal.proposalId),
      );

      // Guard on `resultExportCid: null` so concurrent workers running in the
      // same cluster can never overwrite an already published CID.
      const updated = await this.store.governanceProposal.updateMany({
        where: { proposalId: proposal.proposalId, resultExportCid: null },
        data: {
          resultExportCid: cid,
          resultExportContentHash: contentHash,
          resultExportedAt: new Date(),
          resultExportAttempts: 0,
          resultExportError: null,
        },
      });

      if (updated.count === 0) {
        this.log.warn(
          `[GovernanceResultExportWorker] Proposal ${proposal.proposalId} was ` +
            "exported concurrently; keeping the stored CID.",
        );
        return;
      }

      this.log.info(
        `[GovernanceResultExportWorker] Published result snapshot for ` +
          `proposal ${proposal.proposalId} to IPFS (cid=${cid}).`,
      );
    } catch (error) {
      await this.recordFailure(proposal, errorMessage(error));
    }
  }

  private async recordFailure(
    proposal: ExportableProposalRow,
    message: string,
  ): Promise<void> {
    const attempts = proposal.resultExportAttempts + 1;
    const details = truncate(message, ERROR_MESSAGE_MAX_LENGTH);

    try {
      await this.store.governanceProposal.updateMany({
        where: { proposalId: proposal.proposalId, resultExportCid: null },
        data: { resultExportAttempts: attempts, resultExportError: details },
      });
    } catch (updateError) {
      this.log.error(
        `[GovernanceResultExportWorker] Could not record export failure for ` +
          `proposal ${proposal.proposalId}: ${errorMessage(updateError)}`,
      );
    }

    this.log.error(
      `[GovernanceResultExportWorker] Snapshot export failed for proposal ` +
        `${proposal.proposalId} (attempt ${attempts}/${this.maxAttempts}): ` +
        details,
    );
  }
}

export const governanceResultExportWorker = new GovernanceResultExportWorker();
