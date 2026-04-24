import { Horizon, Keypair } from "@stellar/stellar-sdk";
import type { ServerApi } from "@stellar/stellar-sdk/lib/horizon";
import type { OnChainPrice } from "@prisma/client";
import prisma from "../lib/prisma";
import { getIO } from "../lib/socket";
import stellarProvider from "../lib/stellarProvider";
import dotenv from "dotenv";

dotenv.config();

export interface ConfirmedPrice {
  currency: string;
  rate: number;
  txHash: string;
  memoId: string | null;
  ledgerSeq: number;
  confirmedAt: Date;
}

export class SorobanEventListener {
  private server: Horizon.Server;
  private oraclePublicKey: string;
  private isRunning: boolean = false;
  private pollIntervalMs: number;
  private lastProcessedLedger: number = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pollIntervalMs: number = 15000) {
    const secret =
      process.env.ORACLE_SECRET_KEY || process.env.SOROBAN_ADMIN_SECRET;
    if (!secret) {
      throw new Error(
        "ORACLE_SECRET_KEY or SOROBAN_ADMIN_SECRET not found in environment variables",
      );
    }

    this.oraclePublicKey = Keypair.fromSecret(secret).publicKey();
    this.pollIntervalMs = pollIntervalMs;

    // Use the shared StellarProvider so failover state is shared across all
    // services rather than each managing its own Horizon URL.
    this.server = stellarProvider.getServer();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn("SorobanEventListener is already running");
      return;
    }

    this.isRunning = true;
    console.log(
      `[EventListener] Starting listener for account ${this.oraclePublicKey}`,
    );

    // Initialize last processed ledger from the most recent on-chain record
    const lastRecord = await prisma.onChainPrice.findFirst({
      orderBy: { ledgerSeq: "desc" },
    });
    if (lastRecord) {
      this.lastProcessedLedger = lastRecord.ledgerSeq;
      console.log(
        `[EventListener] Resuming from ledger ${this.lastProcessedLedger}`,
      );
    }

    // Initial poll
    await this.pollTransactions();

    // Start periodic polling
    this.pollTimer = setInterval(() => {
      this.pollTransactions().catch((err) => {
        console.error("[EventListener] Poll error:", err);
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isRunning = false;
    console.log("[EventListener] Stopped");
  }

  restart(newIntervalMs: number): void {
    if (!this.isRunning) return;
    if (newIntervalMs === this.pollIntervalMs) return;
    this.pollIntervalMs = newIntervalMs;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    this.pollTimer = setInterval(() => {
      this.pollTransactions().catch((err) => {
        console.error("[EventListener] Poll error:", err);
      });
    }, this.pollIntervalMs);
    console.info(`[EventListener] Poll interval updated to ${this.pollIntervalMs}ms`);
  }

  private async pollTransactions(): Promise<void> {
    try {
      // Refresh the server reference in case a failover occurred since last poll
      this.server = stellarProvider.getServer();

      const transactions = await this.server
        .transactions()
        .forAccount(this.oraclePublicKey)
        .order("desc")
        .limit(50)
        .call();

      const confirmedPrices: ConfirmedPrice[] = [];

      for (const tx of transactions.records) {
        const ledgerSeq = tx.ledger_attr;

        // Skip already processed transactions
        if (ledgerSeq <= this.lastProcessedLedger) {
          continue;
        }

        // Only process transactions with our memo prefix
        const memoId = this.extractMemoId(tx);
        if (!memoId || !memoId.startsWith("SF-")) {
          continue;
        }

        // Parse price updates from operations
        const prices = await this.parseOperations(tx, memoId);
        confirmedPrices.push(...prices);
      }

      if (confirmedPrices.length > 0) {
        await this.saveConfirmedPrices(confirmedPrices);
        this.emitPriceUpdates(confirmedPrices);

        // Update last processed ledger
        const maxLedger = Math.max(...confirmedPrices.map((p) => p.ledgerSeq));
        if (maxLedger > this.lastProcessedLedger) {
          this.lastProcessedLedger = maxLedger;
        }
      }
    } catch (error) {
      // Report to the provider — triggers a failover if this is a 5xx / network error
      stellarProvider.reportFailure(error);

      // Account not found is expected for new accounts with no transactions
      if (error instanceof Error && error.message.includes("status code 404")) {
        console.log("[EventListener] No transactions found for oracle account");
        return;
      }
      throw error;
    }
  }

  private extractMemoId(tx: ServerApi.TransactionRecord): string | null {
    if (tx.memo_type === "text" && tx.memo) {
      return tx.memo;
    }
    return null;
  }

  private async parseOperations(
    tx: ServerApi.TransactionRecord,
    memoId: string,
  ): Promise<ConfirmedPrice[]> {
    const confirmedPrices: ConfirmedPrice[] = [];

    try {
      const operations = await tx.operations();

      for (const op of operations.records) {
        if (op.type !== "manage_data") {
          continue;
        }

        const manageDataOp = op as ServerApi.ManageDataOperationRecord;
        const name = manageDataOp.name;

        // Parse operation name format: <CURRENCY>_PRICE
        if (!name.endsWith("_PRICE")) {
          continue;
        }

        const currency = name.replace("_PRICE", "");
        const valueBase64 = manageDataOp.value;

        if (!valueBase64) {
          continue;
        }

        // Decode base64 value to string then parse as number
        const valueStr = atob(String(valueBase64));
        const rate = parseFloat(valueStr);

        if (isNaN(rate)) {
          console.warn(
            `[EventListener] Invalid rate value for ${currency}: ${valueStr}`,
          );
          continue;
        }

        confirmedPrices.push({
          currency,
          rate,
          txHash: tx.hash,
          memoId,
          ledgerSeq: tx.ledger_attr,
          confirmedAt: new Date(tx.created_at),
        });
      }
    } catch (error) {
      console.error(
        `[EventListener] Error parsing operations for tx ${tx.hash}:`,
        error,
      );
    }

    return confirmedPrices;
  }

  private async saveConfirmedPrices(prices: ConfirmedPrice[]): Promise<void> {
    for (const price of prices) {
      try {
        await prisma.onChainPrice.upsert({
          where: {
            txHash_currency: {
              txHash: price.txHash,
              currency: price.currency,
            },
          },
          update: {},
          create: {
            currency: price.currency,
            rate: price.rate,
            txHash: price.txHash,
            memoId: price.memoId,
            ledgerSeq: price.ledgerSeq,
            confirmedAt: price.confirmedAt,
          },
        });
        console.log(
          `[EventListener] Saved confirmed price: ${price.currency} = ${price.rate} (tx: ${price.txHash.substring(0, 8)}...)`,
        );
      } catch (error) {
        console.error(
          `[EventListener] Error saving price for ${price.currency}:`,
          error,
        );
      }
    }
  }

  private emitPriceUpdates(prices: ConfirmedPrice[]): void {
    try {
      const io = getIO();
      for (const price of prices) {
        io.emit("price:confirmed", {
          currency: price.currency,
          rate: price.rate,
          txHash: price.txHash,
          ledgerSeq: price.ledgerSeq,
          confirmedAt: price.confirmedAt.toISOString(),
        });
      }
    } catch {
      // Socket not initialized (e.g., during tests)
    }
  }

  async getLatestConfirmedPrice(
    currency: string,
  ): Promise<ConfirmedPrice | null> {
    const record = await prisma.onChainPrice.findFirst({
      where: { currency: currency.toUpperCase() },
      orderBy: { confirmedAt: "desc" },
    });

    if (!record) {
      return null;
    }

    return {
      currency: record.currency,
      rate: Number(record.rate),
      txHash: record.txHash,
      memoId: record.memoId,
      ledgerSeq: record.ledgerSeq,
      confirmedAt: record.confirmedAt,
    };
  }

  async getConfirmedPriceHistory(
    currency: string,
    limit: number = 100,
  ): Promise<ConfirmedPrice[]> {
    const records = await prisma.onChainPrice.findMany({
      where: { currency: currency.toUpperCase() },
      orderBy: { confirmedAt: "desc" },
      take: limit,
    });

    return records.map((record: OnChainPrice) => ({
      currency: record.currency,
      rate: Number(record.rate),
      txHash: record.txHash,
      memoId: record.memoId,
      ledgerSeq: record.ledgerSeq,
      confirmedAt: record.confirmedAt,
    }));
  }

  isActive(): boolean {
    return this.isRunning;
  }

  getOraclePublicKey(): string {
    return this.oraclePublicKey;
  }
}
