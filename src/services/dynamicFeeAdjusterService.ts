import prisma from "../lib/prisma";
import { Keypair, TransactionBuilder, Account, Contract, nativeToScVal, xdr, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import stellarProvider from "../lib/stellarProvider";
import { getStellarNetworkPassphrase } from "../lib/stellarNetwork";
import { sequenceManager } from "./sequence-manager";
import { signer } from "../signer";
import { logger } from "../utils/logger";

const VOLATILITY_THRESHOLD_LOW = 0.01;
const VOLATILITY_THRESHOLD_MEDIUM = 0.05;

const FEE_TIER_LOW = 10;
const FEE_TIER_MEDIUM = 30;
const FEE_TIER_HIGH = 100;

const COOLDOWN_MS = 4 * 60 * 60 * 1000;

type FeeRegime = "LOW" | "MEDIUM" | "HIGH";

export class DynamicFeeAdjusterService {
  private static interval: NodeJS.Timeout | null = null;
  private static lastAdjustment = new Map<string, number>();

  public static start() {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.checkAndAdjustFees().catch(err => console.error("DynamicFeeAdjuster error:", err));
    }, 15 * 60 * 1000);
    this.checkAndAdjustFees().catch(err => console.error("DynamicFeeAdjuster error:", err));
    console.log("⚖️ DynamicFeeAdjusterService started");
  }

  public static stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private static async checkAndAdjustFees() {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    const activePairs = await prisma.ohlcvCandle.findMany({
      where: { timestamp: { gte: oneHourAgo } },
      distinct: ['pair'],
      select: { pair: true }
    });

    for (const { pair } of activePairs) {
      const candles = await prisma.ohlcvCandle.findMany({
        where: { pair, timestamp: { gte: oneHourAgo } },
        orderBy: { timestamp: 'asc' }
      });

      if (candles.length < 2) continue;

      const prices = candles.map(c => parseFloat(c.close.toString()));
      const mean = prices.reduce((sum, p) => sum + p, 0) / prices.length;
      const squaredDiffs = prices.map(p => Math.pow(p - mean, 2));
      const variance = squaredDiffs.reduce((sum, d) => sum + d, 0) / (prices.length - 1);
      const stdDev = Math.sqrt(variance);
      const volatility = stdDev / mean;

      let regime: FeeRegime = "LOW";
      let targetFee = FEE_TIER_LOW;
      if (volatility >= VOLATILITY_THRESHOLD_MEDIUM) {
        regime = "HIGH";
        targetFee = FEE_TIER_HIGH;
      } else if (volatility >= VOLATILITY_THRESHOLD_LOW) {
        regime = "MEDIUM";
        targetFee = FEE_TIER_MEDIUM;
      }

      const lastUpdate = this.lastAdjustment.get(pair) || 0;
      if (Date.now() - lastUpdate < COOLDOWN_MS) {
        logger.info(`[DynamicFee] Skipping ${pair} - cooldown active`);
        continue;
      }

      try {
        await this.updateContractFee(pair, targetFee, regime);
        this.lastAdjustment.set(pair, Date.now());
      } catch (err) {
        logger.error(`[DynamicFee] Failed to update fee for ${pair}:`, err);
      }
    }
  }

  private static async updateContractFee(pair: string, feeBps: number, regime: FeeRegime) {
    const contractId = process.env.CONTRACT_ID;
    if (!contractId) {
      logger.warn("CONTRACT_ID not set, skipping fee update");
      return;
    }

    logger.info(`[DynamicFee] Updating fee for ${pair} to ${feeBps} bps (Regime: ${regime})`);

    const publicKey = await signer.getPublicKey();
    const sequence = await sequenceManager.getNextSequence(publicKey);
    const account = new Account(publicKey, sequence);
    const server = stellarProvider.getServer();
    const feeStats = await server.feeStats();
    const recommendedFee = Math.max(parseInt(feeStats.fee_charged.p50, 10), 100).toString();

    const transaction = new TransactionBuilder(account, {
      fee: recommendedFee,
      networkPassphrase: getStellarNetworkPassphrase(),
    })
      .addOperation(
        new Contract(contractId).call(
          "update_fee_tier",
          nativeToScVal(pair, { type: "string" }),
          nativeToScVal(feeBps, { type: "u32" })
        )
      )
      .setTimeout(30)
      .build();

    const rpcServer = stellarProvider.getRpcServer();
    const simulation = await rpcServer.simulateTransaction(transaction);
    if (SorobanRpc.Api.isSimulationError(simulation)) {
        throw new Error(`Simulation failed: ${simulation.error}`);
    }

    const prepared = SorobanRpc.assembleTransaction(transaction, simulation).build();
    const sig = await signer.sign(prepared.hash());
    const keypair = Keypair.fromPublicKey(publicKey);
    prepared.signatures.push(
      new xdr.DecoratedSignature({
        hint: keypair.signatureHint(),
        signature: sig,
      })
    );

    const submitted = await rpcServer.sendTransaction(prepared);
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await rpcServer.getTransaction(submitted.hash);
      if (result.status === "SUCCESS") {
        logger.info(`[DynamicFee] Successfully updated fee for ${pair}. Hash: ${submitted.hash}`);
        return;
      }
      if (result.status === "FAILED") {
        throw new Error(`Transaction failed: ${submitted.hash}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Timeout waiting for transaction: ${submitted.hash}`);
  }
}
