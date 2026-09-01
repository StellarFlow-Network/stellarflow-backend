import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export async function ingestLiquidityEvent(event: {
  poolId: string;
  user: string;
  type: "MINT" | "BURN" | "SWAP";
  amountA: number;
  amountB: number;
  txHash: string;
  timestamp: Date;
}) {
  return await prisma.liquidityEvent.create({
    data: {
      poolId: event.poolId,
      user: event.user,
      type: event.type,
      amountA: event.amountA,
      amountB: event.amountB,
      txHash: event.txHash,
      timestamp: event.timestamp,
    },
  });
}
