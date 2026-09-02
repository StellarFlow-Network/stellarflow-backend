import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type {
  QueuedRebalancingSwap,
  RebalancingPlan,
  RebalancingQueue,
} from "./types";

export class PrismaRebalancingQueue implements RebalancingQueue {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueueUnlessPending(
    plan: RebalancingPlan,
  ): Promise<QueuedRebalancingSwap | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const pending = await tx.rebalancingSwap.findFirst({
          where: {
            poolKey: plan.poolKey,
            status: { in: ["QUEUED", "PROCESSING"] },
          },
          select: { id: true },
        });
        if (pending) return null;

        const swap = await tx.rebalancingSwap.create({
          data: { ...plan, id: randomUUID() },
        });
        return {
          ...plan,
          id: swap.id,
          status: "QUEUED" as const,
          createdAt: swap.createdAt,
        };
      });
    } catch (error) {
      // The migration's partial unique index closes the race between app instances.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "P2002"
      ) {
        return null;
      }
      throw error;
    }
  }
}
