import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import { calculateLpEarnings } from "../services/liquidity/earningsCalculator";

const prisma = new PrismaClient();

export class LpSnapshotJob {
  constructor() {
    // Schedule to run daily at midnight
    cron.schedule("0 0 * * *", () => this.runSnapshot());
  }

  async runSnapshot(): Promise<void> {
    console.info(`[LpSnapshotJob] Starting daily snapshot.`);
    
    // 1. Get all unique users in liquidity events
    const users = await prisma.liquidityEvent.findMany({
      select: { user: true, poolId: true },
      distinct: ["user", "poolId"],
    });

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    // 2. For each user/pool, calculate earnings and save snapshot
    for (const { user, poolId } of users) {
      const earnings = await calculateLpEarnings(user, poolId, yesterday, new Date());
      
      await prisma.userLpSnapshot.create({
        data: {
          user,
          poolId,
          liquidity: 0, // Need to implement liquidity tracking
          accumulatedFees: earnings.estimatedFees,
          snapshotDate: yesterday,
        },
      });
    }
    console.info(`[LpSnapshotJob] Snapshot completed.`);
  }
}
