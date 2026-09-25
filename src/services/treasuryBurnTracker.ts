import prisma from "../lib/prisma";
import { logger } from "../utils/logger";

export interface BurnEventInput {
  chainId?: number;
  transactionHash: string;
  logIndex?: number;
  tokenAddress?: string;
  amount: string | number;
  destinationChainId?: string;
  eventTimestamp: Date;
}

export class TreasuryBurnTracker {
  private get client(): any { return prisma as any; }

  async recordBurn(event: BurnEventInput): Promise<void> {
    try {
      await this.client.treasuryBurnEvent?.upsert({
        where: { transactionHash_logIndex: { transactionHash: event.transactionHash, logIndex: event.logIndex ?? 0 } },
        create: { ...event, logIndex: event.logIndex ?? 0, amount: event.amount },
        update: {},
      });
    } catch (error) {
      logger.error("[TreasuryBurnTracker] Failed to index TokensBurned event", error);
      throw error;
    }
  }

  async getStats() {
    const burns = await this.client.treasuryBurnEvent?.findMany({ orderBy: { eventTimestamp: "asc" } }) ?? [];
    const allocations = await this.client.treasuryRevenueAllocation?.findMany({ orderBy: { periodEnd: "desc" }, take: 1 }) ?? [];
    const cumulativeBurnTotal = burns.reduce((total: number, event: any) => total + Number(event.amount), 0);
    const allocation = allocations[0] ?? null;
    return {
      cumulativeBurnTotal,
      burnEventCount: burns.length,
      allocation: allocation ? {
        totalRevenue: Number(allocation.totalRevenue),
        burnAllocation: Number(allocation.burnAllocation),
        treasuryAllocation: Number(allocation.treasuryAllocation),
        burnPercentage: Number(allocation.burnPercentage),
        treasuryPercentage: Number(allocation.treasuryPercentage),
        periodStart: allocation.periodStart,
        periodEnd: allocation.periodEnd,
      } : null,
    };
  }

  recordAllocation(input: { periodStart: Date; periodEnd: Date; totalRevenue: number; burnAllocation: number; treasuryAllocation: number }) {
    const burnPercentage = input.totalRevenue === 0 ? 0 : (input.burnAllocation / input.totalRevenue) * 100;
    const treasuryPercentage = input.totalRevenue === 0 ? 0 : (input.treasuryAllocation / input.totalRevenue) * 100;
    return this.client.treasuryRevenueAllocation.upsert({
      where: { periodStart_periodEnd: { periodStart: input.periodStart, periodEnd: input.periodEnd } },
      create: { ...input, burnPercentage, treasuryPercentage },
      update: { ...input, burnPercentage, treasuryPercentage },
    });
  }
}

export const treasuryBurnTracker = new TreasuryBurnTracker();