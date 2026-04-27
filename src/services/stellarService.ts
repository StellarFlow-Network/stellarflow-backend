import dotenv from "dotenv";
import {
  Keypair,
  TransactionBuilder,
  Transaction,
  Operation,
  Networks,
  Memo,
  Horizon,
  xdr,
  Account,
} from "@stellar/stellar-sdk";
import stellarProvider from "../lib/stellarProvider";
import { sequenceManager } from "./sequence-manager";
import { assertSigningAllowed } from "../state/appState";
import { getSecretKey } from "./secretManager";

dotenv.config();

export class StellarService {
  private server: Horizon.Server;
  private network: string;
  private readonly MAX_RETRIES = 3;
  private readonly FEE_INCREMENT_PERCENTAGE = 0.5; // 50% increase each retry
  private readonly RETRY_DELAY_MS = 2000; // 2 seconds delay between retries

  constructor() {
    this.network = process.env.STELLAR_NETWORK || "TESTNET";

    // Use the shared StellarProvider so all services benefit from the same
    // failover state rather than each managing their own Horizon URL.
    this.server = stellarProvider.getServer();
  }

  /**
   * Returns a Keypair derived from the currently active secret key.
   * Called at sign time so key rotations are reflected immediately.
   */
  private getKeypair(): Keypair {
    return Keypair.fromSecret(getSecretKey());
  }

  /**
   * Fetches the recommended transaction fee from Horizon fee_stats.
   */
  async getRecommendedFee(): Promise<string> {
    const feeStats = await this.server.feeStats();
    const fee = parseInt(feeStats.fee_charged.p50, 10);
    return Math.max(fee, 100).toString();
  }

  /**
   * Submit a price update to the Stellar network.
   */
  async submitPriceUpdate(
    currency: string,
    price: number,
    memoId: string,
  ): Promise<string> {
    await assertSigningAllowed();

    const baseFee = parseInt(await this.getRecommendedFee(), 10);

    const result = await this.submitTransactionWithRetries(
      (sourceAccount, currentFee) => {
        return new TransactionBuilder(sourceAccount, {
          fee: currentFee.toString(),
          networkPassphrase:
            this.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET,
        })
          .addOperation(
            Operation.manageData({
              name: `${currency}_PRICE`,
              value: price.toString(),
            }),
          )
          .addMemo(Memo.text(memoId))
          .setTimeout(60)
          .build();
      },
      this.MAX_RETRIES,
      baseFee,
    );

    console.info(`✅ Price update for ${currency} confirmed. Hash: ${result.hash}`);
    return result.hash;
  }

  /**
   * Submit multiple price updates in a single bundle.
   */
  async submitBatchedPriceUpdates(
    updates: Array<{ currency: string; price: number }>,
    memoId: string,
  ): Promise<string> {
    if (updates.length === 0) {
      throw new Error("Cannot submit empty batch of price updates");
    }

    await assertSigningAllowed();
    const baseFee = parseInt(await this.getRecommendedFee(), 10);

    const result = await this.submitTransactionWithRetries(
      (sourceAccount, currentFee) => {
        const builder = new TransactionBuilder(sourceAccount, {
          fee: currentFee.toString(),
          networkPassphrase:
            this.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET,
        });

        for (const update of updates) {
          builder.addOperation(
            Operation.manageData({
              name: `${update.currency}_PRICE`,
              value: update.price.toString(),
            }),
          );
        }

        return builder.addMemo(Memo.text(memoId)).setTimeout(60).build();
      },
      this.MAX_RETRIES,
      baseFee,
    );

    const currencies = updates.map((u) => u.currency).join(", ");
    console.info(`✅ Batched price update for [${currencies}] confirmed. Hash: ${result.hash}`);
    return result.hash;
  }

  /**
   * Submit a multi-signed price update.
   */
  async submitMultiSignedPriceUpdate(
    currency: string,
    price: number,
    memoId: string,
    signatures: Array<{ signerPublicKey: string; signature: string }>,
  ): Promise<string> {
    await assertSigningAllowed();
    const baseFee = parseInt(await this.getRecommendedFee(), 10);

    const result = await this.submitMultiSignedTransaction(
      (sourceAccount, currentFee) => {
        return new TransactionBuilder(sourceAccount, {
          fee: currentFee.toString(),
          networkPassphrase:
            this.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET,
        })
          .addOperation(
            Operation.manageData({
              name: `${currency}_PRICE`,
              value: price.toString(),
            }),
          )
          .addMemo(Memo.text(memoId))
          .setTimeout(60)
          .build();
      },
      signatures,
      this.MAX_RETRIES,
      baseFee,
    );

    console.info(`✅ Multi-signed price update for ${currency} confirmed. Hash: ${result.hash}`);
    return result.hash;
  }

  /**
   * Generic method to submit a transaction with retries.
   */
  async submitTransactionWithRetries(
    builderFn: (
      sourceAccount: Account | Horizon.AccountResponse,
      currentFee: number,
    ) => Transaction,
    maxRetries = this.MAX_RETRIES,
    baseFee: number,
  ): Promise<any> {
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        // Always resolve the current active server — may have changed after a failover
        this.server = stellarProvider.getServer();

        // Use SequenceManager to avoid collisions and redundant loadAccount calls
        const nextSequence = await sequenceManager.getNextSequence(
          this.getKeypair().publicKey()
        );

        const sourceAccount = new Account(
          this.getKeypair().publicKey(),
          nextSequence
        );

        const currentFee = Math.floor(
          baseFee * (1 + this.FEE_INCREMENT_PERCENTAGE * attempt),
        );

        const transaction = builderFn(sourceAccount, currentFee);
        await assertSigningAllowed();
        transaction.sign(this.getKeypair());

        return await this.server.submitTransaction(transaction);
      } catch (error: any) {
        const resultCode = error.response?.data?.extras?.result_codes?.transaction;

        if (resultCode === "tx_bad_seq") {
          console.warn("⚠️ SequenceManager: tx_bad_seq detected. Invalidating sequence and retrying...");
          sequenceManager.invalidate(this.getKeypair().publicKey());
        }

        attempt++;
        stellarProvider.reportFailure(error);

        if (this.isStuckError(error) && attempt <= maxRetries) {
          console.warn(`⚠️ Transaction stuck or fee too low (Attempt ${attempt}). Bumping fee and retrying...`);
          await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY_MS));
          continue;
        }

        throw error;
      }
    }

    throw new Error(`Failed to submit transaction after ${maxRetries + 1} attempts`);
  }

  /**
   * Submit a multi-signed transaction with retries.
   */
  private async submitMultiSignedTransaction(
    builderFn: (
      sourceAccount: Account | Horizon.AccountResponse,
      currentFee: number,
    ) => Transaction,
    signatures: Array<{ signerPublicKey: string; signature: string }>,
    maxRetries = this.MAX_RETRIES,
    baseFee: number,
  ): Promise<any> {
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        this.server = stellarProvider.getServer();

        const nextSequence = await sequenceManager.getNextSequence(
          this.getKeypair().publicKey()
        );

        const sourceAccount = new Account(
          this.getKeypair().publicKey(),
          nextSequence
        );

        const currentFee = Math.floor(
          baseFee * (1 + this.FEE_INCREMENT_PERCENTAGE * attempt),
        );

        const transaction = builderFn(sourceAccount, currentFee);

        await assertSigningAllowed();
        transaction.sign(this.getKeypair());

        for (const sig of signatures) {
          if (sig.signerPublicKey === this.getKeypair().publicKey()) continue;

          try {
            const signatureBuffer = Buffer.from(sig.signature, "hex");
            const signerKeypair = Keypair.fromPublicKey(sig.signerPublicKey);

            const decoratedSignature = new xdr.DecoratedSignature({
              hint: signerKeypair.signatureHint(),
              signature: signatureBuffer,
            });

            transaction.signatures.push(decoratedSignature);
          } catch (error) {
            console.error(`[StellarService] Failed to add signature for ${sig.signerPublicKey}:`, error);
          }
        }

        return await this.server.submitTransaction(transaction);
      } catch (error: any) {
        const resultCode = error.response?.data?.extras?.result_codes?.transaction;

        if (resultCode === "tx_bad_seq") {
          console.warn("⚠️ SequenceManager: tx_bad_seq detected in multi-sig. Invalidating sequence...");
          sequenceManager.invalidate(this.getKeypair().publicKey());
        }

        attempt++;
        stellarProvider.reportFailure(error);

        if (this.isStuckError(error) && attempt <= maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, this.RETRY_DELAY_MS));
          continue;
        }

        throw error;
      }
    }

    throw new Error(`Failed to submit multi-signed transaction after ${maxRetries + 1} attempts`);
  }

  private isStuckError(error: any): boolean {
    const resultCode = error.response?.data?.extras?.result_codes?.transaction;
    return (
      resultCode === "tx_too_late" ||
      resultCode === "tx_insufficient_fee" ||
      resultCode === "tx_bad_seq" ||
      error.message?.includes("timeout") ||
      error.code === "ECONNABORTED"
    );
  }

  generateMemoId(currency: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    const id = `SF-${currency}-${timestamp}-${random}`;
    return id.substring(0, 28);
  }
}