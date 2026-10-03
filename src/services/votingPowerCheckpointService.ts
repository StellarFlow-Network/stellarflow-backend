/**
 * VotingPowerCheckpointService
 *
 * Handles storage and querying of historical voting power checkpoints.
 * Implements the requirements for Issue #1044:
 * - Index checkpointCreated events and write address voting weights per ledger to the database
 * - Query exact historical voting power V(address, ledger, number) instantly
 * - Optimize database indexing to support < 20ms query response times
 */

import prisma from "../lib/prisma.js";
import { logger } from "../utils/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CheckpointPayload {
  accountId: string;
  ledgerSequence: number;
  votingWeight: string;
}

export interface VotingPowerCheckpointResult {
  accountId: string;
  ledgerSequence: number;
  votingWeight: string;
  createdAt: Date;
}

// ─── Ingestion ────────────────────────────────────────────────────────────────

/**
 * Stores a voting power checkpoint for an account at a specific ledger.
 * Upserts to handle duplicate events from reprocessing.
 */
export async function storeVotingPowerCheckpoint(
  payload: CheckpointPayload,
): Promise<void> {
  const { accountId, ledgerSequence, votingWeight } = payload;

  await prisma.votingPowerCheckpoint.upsert({
    where: {
      accountId_ledgerSequence: {
        accountId,
        ledgerSequence,
      },
    },
    create: {
      accountId,
      ledgerSequence,
      votingWeight,
    },
    update: {
      votingWeight,
    },
  });

  logger.info(
    `[VotingPowerCheckpointService] Stored checkpoint: account=${accountId} ledger=${ledgerSequence} weight=${votingWeight}`,
  );
}

/**
 * Batch stores multiple voting power checkpoints for efficiency.
 * Useful when processing multiple accounts at the same ledger.
 */
export async function batchStoreVotingPowerCheckpoints(
  payloads: CheckpointPayload[],
): Promise<void> {
  if (payloads.length === 0) return;

  await prisma.$transaction(
    payloads.map((payload) =>
      prisma.votingPowerCheckpoint.upsert({
        where: {
          accountId_ledgerSequence: {
            accountId: payload.accountId,
            ledgerSequence: payload.ledgerSequence,
          },
        },
        create: {
          accountId: payload.accountId,
          ledgerSequence: payload.ledgerSequence,
          votingWeight: payload.votingWeight,
        },
        update: {
          votingWeight: payload.votingWeight,
        },
      }),
    ),
  );

  logger.info(
    `[VotingPowerCheckpointService] Batch stored ${payloads.length} checkpoints`,
  );
}

// ─── Querying ────────────────────────────────────────────────────────────────

/**
 * Queries the exact historical voting power for an account at a specific ledger.
 * This is the primary query pattern: V(address, ledger, number)
 *
 * Returns null if no checkpoint exists for that account at that ledger.
 */
export async function getVotingPowerAtLedger(
  accountId: string,
  ledgerSequence: number,
): Promise<VotingPowerCheckpointResult | null> {
  const checkpoint = await prisma.votingPowerCheckpoint.findUnique({
    where: {
      accountId_ledgerSequence: {
        accountId,
        ledgerSequence,
      },
    },
  });

  if (!checkpoint) return null;

  return {
    accountId: checkpoint.accountId,
    ledgerSequence: checkpoint.ledgerSequence,
    votingWeight: checkpoint.votingWeight.toString(),
    createdAt: checkpoint.createdAt,
  };
}

/**
 * Finds the most recent checkpoint for an account at or before a given ledger.
 * Useful for determining voting power when an exact ledger match doesn't exist.
 */
export async function getVotingPowerAtOrBeforeLedger(
  accountId: string,
  ledgerSequence: number,
): Promise<VotingPowerCheckpointResult | null> {
  const checkpoint = await prisma.votingPowerCheckpoint.findFirst({
    where: {
      accountId,
      ledgerSequence: {
        lte: ledgerSequence,
      },
    },
    orderBy: {
      ledgerSequence: "desc",
    },
  });

  if (!checkpoint) return null;

  return {
    accountId: checkpoint.accountId,
    ledgerSequence: checkpoint.ledgerSequence,
    votingWeight: checkpoint.votingWeight.toString(),
    createdAt: checkpoint.createdAt,
  };
}

/**
 * Gets all voting power checkpoints for a specific ledger.
 * Useful for proposal eligibility checks at a particular ledger number.
 */
export async function getCheckpointsAtLedger(
  ledgerSequence: number,
): Promise<VotingPowerCheckpointResult[]> {
  const checkpoints = await prisma.votingPowerCheckpoint.findMany({
    where: {
      ledgerSequence,
    },
    orderBy: {
      accountId: "asc",
    },
  });

  return checkpoints.map((c) => ({
    accountId: c.accountId,
    ledgerSequence: c.ledgerSequence,
    votingWeight: c.votingWeight.toString(),
    createdAt: c.createdAt,
  }));
}

/**
 * Gets the checkpoint history for an account within a ledger range.
 */
export async function getAccountCheckpointHistory(
  accountId: string,
  fromLedger?: number,
  toLedger?: number,
  limit: number = 100,
): Promise<VotingPowerCheckpointResult[]> {
  const where: Record<string, unknown> = { accountId };

  if (fromLedger !== undefined || toLedger !== undefined) {
    where.ledgerSequence = {
      ...(fromLedger !== undefined ? { gte: fromLedger } : {}),
      ...(toLedger !== undefined ? { lte: toLedger } : {}),
    };
  }

  const checkpoints = await prisma.votingPowerCheckpoint.findMany({
    where,
    orderBy: {
      ledgerSequence: "desc",
    },
    take: limit,
  });

  return checkpoints.map((c) => ({
    accountId: c.accountId,
    ledgerSequence: c.ledgerSequence,
    votingWeight: c.votingWeight.toString(),
    createdAt: c.createdAt,
  }));
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Deletes checkpoints older than a specified number of days.
 * Useful for maintenance to prevent unbounded growth.
 */
export async function deleteOldCheckpoints(daysToKeep: number = 365): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

  const result = await prisma.votingPowerCheckpoint.deleteMany({
    where: {
      createdAt: {
        lt: cutoffDate,
      },
    },
  });

  logger.info(
    `[VotingPowerCheckpointService] Deleted ${result.count} old checkpoints`,
  );

  return result.count;
}
