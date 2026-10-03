import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { governanceWebhookBroadcaster } from "./governanceWebhookBroadcaster";

export interface TimelockEntry {
  id: number;
  proposalId: string;
  contractId: string;
  actionType: string | null;
  actionData: string | null;
  status: string;
  expiresAt: Date;
  transactionHash: string | null;
  executedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TimelockListFilters {
  status?: string;
  contractId?: string;
  actionType?: string;
  limit?: number;
  offset?: number;
}

export class TimelockService {
  async listActions(filters: TimelockListFilters): Promise<{
    entries: TimelockEntry[];
    total: number;
  }> {
    const { status, contractId, actionType, limit = 50, offset = 0 } = filters;

    const conditions: Prisma.Sql[] = [];
    if (status) {
      if (status.toLowerCase() === "expired") {
        conditions.push(Prisma.sql`"status" IN ('Expired', 'EXPIRED')`);
      } else {
        conditions.push(Prisma.sql`"status" = ${status}`);
      }
    }
    if (contractId) conditions.push(Prisma.sql`"contractId" = ${contractId}`);
    if (actionType) conditions.push(Prisma.sql`"actionType" = ${actionType}`);

    const whereSQL = conditions.length
      ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`
      : Prisma.empty;

    const countResult = await prisma.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT COUNT(*) as count FROM "GovernanceProposal" ${whereSQL}`,
    );
    const total = Number(countResult[0]?.count ?? 0);

    const entries = await prisma.$queryRaw<TimelockEntry[]>(Prisma.sql`
      SELECT "id", "proposalId", "contractId", "actionType", "actionData",
             "status", "expiresAt", "transactionHash", "executedAt",
             "cancelledAt", "createdAt", "updatedAt"
      FROM "GovernanceProposal"
      ${whereSQL}
      ORDER BY "createdAt" DESC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return { entries, total };
  }

  async getActionById(id: number): Promise<TimelockEntry | null> {
    const rows = await prisma.$queryRaw<TimelockEntry[]>`
      SELECT "id", "proposalId", "contractId", "actionType", "actionData",
             "status", "expiresAt", "transactionHash", "executedAt",
             "cancelledAt", "createdAt", "updatedAt"
      FROM "GovernanceProposal"
      WHERE "id" = ${id}
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async getStatusCounts(): Promise<{
    queued: number;
    executed: number;
    cancelled: number;
    expired: number;
    total: number;
  }> {
    const rows = await prisma.$queryRaw<{ status: string; count: bigint }[]>`
      SELECT "status", COUNT(*) as count
      FROM "GovernanceProposal"
      GROUP BY "status"
    `;

    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      counts[row.status] = Number(row.count);
      total += Number(row.count);
    }

    return {
      queued: counts["Queued"] ?? counts["QUEUED"] ?? 0,
      executed: counts["Executed"] ?? counts["EXECUTED"] ?? 0,
      cancelled: counts["Cancelled"] ?? counts["CANCELLED"] ?? 0,
      expired: (counts["Expired"] ?? 0) + (counts["EXPIRED"] ?? 0),
      total,
    };
  }

  computeETA(expiresAt: Date): {
    secondsUntilRelease: number;
    releaseAt: string;
    isReleaseable: boolean;
  } {
    const now = Date.now();
    const releaseTime = expiresAt.getTime();
    const secondsUntilRelease = Math.max(
      0,
      Math.floor((releaseTime - now) / 1000),
    );

    return {
      secondsUntilRelease,
      releaseAt: expiresAt.toISOString(),
      isReleaseable: now >= releaseTime,
    };
  }

  async cancelAction(id: number): Promise<TimelockEntry | null> {
    const rows = await prisma.$queryRaw<TimelockEntry[]>`
      UPDATE "GovernanceProposal"
      SET "status" = 'Cancelled', "cancelledAt" = NOW(), "updatedAt" = NOW()
      WHERE "id" = ${id} AND "status" = 'Queued'
      RETURNING "id", "proposalId", "contractId", "actionType", "actionData",
                "status", "expiresAt", "transactionHash", "executedAt",
                "cancelledAt", "createdAt", "updatedAt"
    `;

    const cancelled = rows[0] ?? null;
    if (cancelled) {
      void governanceWebhookBroadcaster
        .broadcastProposalCancelled({
          proposalId: cancelled.proposalId,
          contractId: cancelled.contractId,
          status: "Cancelled",
          actionType: cancelled.actionType,
          expiresAt: cancelled.expiresAt,
          cancelledAt: cancelled.cancelledAt,
        })
        .catch(() => undefined);
    }

    return cancelled;
  }
}

export const timelockService = new TimelockService();
