import cron from "node-cron";
import prisma from "../lib/prisma";
import { getStellarNetwork } from "../lib/stellarNetwork";
import { Horizon } from "@stellar/stellar-sdk";
import stellarProvider from "../lib/stellarProvider";
import { subDays } from "date-fns";

export class ApyWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastPolledLedger: number = 0;
  private horizon = stellarProvider.getServer();
  private vaultIds = process.env.YIELD_VAULT_IDS?.split(",") || ["default-vault"];

  start(): void {
    if (this.timer) return;
    // Check every 5 minutes if 1000 ledgers have passed
    this.timer = setInterval(() => void this.poll(), 5 * 60 * 1000);
    console.info("[ApyWorker] Continuous Yield Strategy APY Calculation Worker started.");
    
    // Also run immediately on start
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async fetchVaultSharePrice(_vaultId: string): Promise<number> {
    // Simulated vault share price
    // In a real scenario, this would query the Soroban contract for get_share_price()
    return 1.0 + Math.random() * 0.05;
  }

  async poll(): Promise<void> {
    try {
      const state = await this.horizon.root();
      const currentLedger = state.history_latest_ledger;

      if (this.lastPolledLedger === 0) {
        // fetch last recorded ledger
        const lastRecord = await prisma.vaultApyMetric.findFirst({
          orderBy: { ledgerSeq: 'desc' }
        });
        this.lastPolledLedger = lastRecord?.ledgerSeq || currentLedger - 1000;
      }

      if (currentLedger - this.lastPolledLedger >= 1000) {
        for (const vaultId of this.vaultIds) {
          const sharePrice = await this.fetchVaultSharePrice(vaultId);
          await this.recordMetrics(vaultId, currentLedger, sharePrice);
        }
        this.lastPolledLedger = currentLedger;
      }
    } catch (error) {
      console.error("[ApyWorker] Error during polling:", error);
    }
  }

  async recordMetrics(vaultId: string, currentLedger: number, sharePrice: number) {
    const now = new Date();
    const sevenDaysAgo = subDays(now, 7);
    const thirtyDaysAgo = subDays(now, 30);

    const past7d = await prisma.vaultApyMetric.findFirst({
      where: { vaultId, timestamp: { lte: sevenDaysAgo } },
      orderBy: { timestamp: 'desc' }
    });
    
    const past30d = await prisma.vaultApyMetric.findFirst({
      where: { vaultId, timestamp: { lte: thirtyDaysAgo } },
      orderBy: { timestamp: 'desc' }
    });

    let apy7d: number | null = null;
    let apy30d: number | null = null;

    if (past7d && Number(past7d.sharePrice) > 0) {
      const yield7d = (sharePrice / Number(past7d.sharePrice));
      apy7d = (Math.pow(yield7d, 365 / 7) - 1) * 100; // as percentage
    }

    if (past30d && Number(past30d.sharePrice) > 0) {
      const yield30d = (sharePrice / Number(past30d.sharePrice));
      apy30d = (Math.pow(yield30d, 365 / 30) - 1) * 100; // as percentage
    }

    await prisma.vaultApyMetric.create({
      data: {
        vaultId,
        ledgerSeq: currentLedger,
        sharePrice: sharePrice,
        apy7d: apy7d,
        apy30d: apy30d,
        timestamp: now,
      }
    });

    console.info(`[ApyWorker] Recorded metrics for vault ${vaultId} at ledger ${currentLedger}: APY 7d = ${apy7d?.toFixed(2)}%, APY 30d = ${apy30d?.toFixed(2)}%`);
  }
}

export const apyWorker = new ApyWorker();
