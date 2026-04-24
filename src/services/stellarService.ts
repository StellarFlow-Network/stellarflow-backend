import {
  Keypair,
  TransactionBuilder,
  Transaction,
  Operation,
  Networks,
  Memo,
  Horizon,
  xdr,
} from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import stellarProvider from "../lib/stellarProvider";
import { assertSigningAllowed } from "../state/appState";

dotenv.config();

export class StellarService {
  private server: Horizon.Server;
  private keypair: Keypair;
  private network: string;
  private readonly MAX_RETRIES = 3;
  private readonly FEE_INCREMENT_PERCENTAGE = 0.5; // 50% increase each retry
  private readonly RETRY_DELAY_MS = 2000; // 2 seconds delay between retries

  constructor() {
    const secret =
      process.env.ORACLE_SECRET_KEY || process.env.SOROBAN_ADMIN_SECRET;
    if (!secret) {
      throw new Error("Stellar secret key not found in environment variables");
    }

    this.keypair = Keypair.fromSecret(secret);
    this.network = process.env.STELLAR_NETWORK || "TESTNET";

    // Use the shared StellarProvider so all services benefits from the same
    // failover state rather than each managing their own Horizon URL.
    this.server = stellarProvider.getServer();
  }

  /**
   * Fetches the recommended transaction fee from Horizon fee_stats.
   * Uses p50 (median) of recent fees to avoid overpaying while ensuring inclusion.
   * @returns Recommended fee in stroops as a string (required by TransactionBuilder)
   */
  async getRecommendedFee(): Promise<string> {
    const feeStats = await this.server.feeStats();
    // p50 = median fee paid in recent ledgers — safe and cost-efficient
    const fee = parseInt(feeStats.fee_charged.p50, 10);
    return Math.max(fee, 100).toString(); // floor at Stellar's base fee (100 stroops)
  }

  /**
   * Submit a price update to the Stellar network with a unique memo ID.
   * Leverages submitTransactionWithRetries for automatic fee bumping if stuck.
   * @param currency - The currency code (e.g., "NGN", "KES")
   * @param price - The current price/rate
   * @param memoId - Unique ID for auditing
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

    console.info(
      `✅ Price update for ${currency} confirmed. Hash: ${result.hash}`,
    );
    return result.hash;
  }

  /**
   * Submit multiple price updates to the Stellar network in a single bundle transaction.
   * Leverages submitTransactionWithRetries for automatic fee bumping if stuck.
   * @param updates - Array of price updates { currency, price }
   * @param memoId - Unique ID for auditing
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
    console.info(
      `✅ Batched price update for [${currencies}] confirmed. Hash: ${result.hash}`,
    );
    return result.hash;
  }

  /**
   * Submit a multi-signed price update to the Stellar network.
   * Accepts signatures from multiple oracle servers.
   * @param currency - The currency code (e.g., "NGN", "KES")
   * @param price - The current price/rate
   * @param memoId - Unique ID for auditing
   * @param signatures - Array of signatures from different signers
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

    console.info(
      `✅ Multi-signed price update for ${currency} confirmed. Hash: ${result.hash}`,
    );
    return result.hash;
  }

  /**
   * Generic method to submit a transaction with retries and automatic fee bumping.
   * Optimizes interaction with the network (including Soroban contracts) by handling congestion.
   * @param builderFn - Function that builds a new transaction for each attempt
   * @param maxRetries - Max number of retries
   * @param baseFee - The starting fee in stroops
   */
  async submitTransactionWithRetries(
    builderFn: (
      sourceAccount: Horizon.AccountResponse,
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

        const sourceAccount = await this.server.loadAccount(
          this.keypair.publicKey(),
        );
        const currentFee = Math.floor(
          baseFee * (1 + this.FEE_INCREMENT_PERCENTAGE * attempt),
        );

        const transaction = builderFn(sourceAccount, currentFee);
        await assertSigningAllowed();
        transaction.sign(this.keypair);

        await assertSigningAllowed();
        return await this.server.submitTransaction(transaction);
      } catch (error: any) {
        attempt++;

        // Report to the provider — it will switch to the next node if this is
        // a 5xx / network error, so the next attempt uses a healthy node.
        stellarProvider.reportFailure(error);

        const isStuck = this.isStuckError(error);

        if (isStuck && attempt <= maxRetries) {
          console.warn(
            `⚠️ Transaction stuck or fee too low (Attempt ${attempt}). Bumping fee and retrying in ${this.RETRY_DELAY_MS}ms...`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, this.RETRY_DELAY_MS),
          );
          continue;
        }

        throw error;
      }
    }

    throw new Error(
      `Failed to submit transaction after ${maxRetries + 1} attempts`,
    );
  }

  /**
   * Submit a multi-signed transaction to the Stellar network.
   * Adds multiple signatures to the transaction before submission.
   * @param builderFn - Function that builds the transaction
   * @param signatures - Array of signatures with signer public keys
   * @param maxRetries - Max number of retries
   * @param baseFee - The starting fee in stroops
   */
  private async submitMultiSignedTransaction(
    builderFn: (
      sourceAccount: Horizon.AccountResponse,
      currentFee: number,
    ) => Transaction,
    signatures: Array<{ signerPublicKey: string; signature: string }>,
    maxRetries = this.MAX_RETRIES,
    baseFee: number,
  ): Promise<any> {
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        // Always resolve the current active server — may have changed after a failover
        this.server = stellarProvider.getServer();

        const sourceAccount = await this.server.loadAccount(
          this.keypair.publicKey(),
        );
        const currentFee = Math.floor(
          baseFee * (1 + this.FEE_INCREMENT_PERCENTAGE * attempt),
        );

        const transaction = builderFn(sourceAccount, currentFee);

        // Sign with the local keypair first
        await assertSigningAllowed();
        transaction.sign(this.keypair);

        // Add signatures from other signers
        for (const sig of signatures) {
          // Skip if this is the local signer's public key (already signed)
          if (sig.signerPublicKey === this.keypair.publicKey()) {
            continue;
          }

          // Add the remote signature to the transaction
          try {
            // Convert hex signature to buffer
            const signatureBuffer = Buffer.from(sig.signature, "hex");

            // Create a keypair from the signer's public key to get the hint
            const signerKeypair = Keypair.fromPublicKey(sig.signerPublicKey);

            // Add the signature to the transaction
            const decoratedSignature = new xdr.DecoratedSignature({
              hint: signerKeypair.signatureHint(),
              signature: signatureBuffer,
            });

            transaction.signatures.push(decoratedSignature);
          } catch (error) {
            console.error(
              `[StellarService] Failed to add signature for ${sig.signerPublicKey}:`,
              error,
            );
            // Continue without this signature (may cause failure on Stellar side)
          }
        }

        await assertSigningAllowed();
        return await this.server.submitTransaction(transaction);
      } catch (error: any) {
        attempt++;

        // Report to the provider — it will switch to the next node if this is
        // a 5xx / network error, so the next attempt uses a healthy node.
        stellarProvider.reportFailure(error);

        const isStuck = this.isStuckError(error);

        if (isStuck && attempt <= maxRetries) {
          console.warn(
            `⚠️ Multi-sig transaction stuck or fee too low (Attempt ${attempt}). Bumping fee and retrying in ${this.RETRY_DELAY_MS}ms...`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, this.RETRY_DELAY_MS),
          );
          continue;
        }

        throw error;
      }
    }

    throw new Error(
      `Failed to submit multi-signed transaction after ${maxRetries + 1} attempts`,
    );
  }

  /**
   * Get the network passphrase for the current network.
   * Ensures proper network identification for multi-sig operations.
   */
  private getNetworkPassphrase(): string {
    return this.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET;
  }

  /**
   * Determines if a transaction error indicates it is "stuck" or needs a fee bump.
   */
  private isStuckError(error: any): boolean {
    const resultCode = error.response?.data?.extras?.result_codes?.transaction;

    // tx_too_late: Transaction timebounds expired before inclusion
    // tx_insufficient_fee: Mandatory fee not met
    // tx_bad_seq: Sequence number mismatch (often due to race conditions/congestion)
    // timeout: Network/SDK timeout during submission
    return (
      resultCode === "tx_too_late" ||
      resultCode === "tx_insufficient_fee" ||
      resultCode === "tx_bad_seq" ||
      error.message?.includes("timeout") ||
      error.code === "ECONNABORTED"
    );
  }

  /**
   * Generate a unique ID for the transaction memo
   * Format: SF-<CURRENCY>-<TIMESTAMP>
   */
  generateMemoId(currency: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const random = Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, "0");
    // Stellar MemoText limit is 28 bytes
    const id = `SF-${currency}-${timestamp}-${random}`;
    return id.substring(0, 28);
  }
}
