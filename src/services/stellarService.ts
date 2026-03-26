import {
  Keypair,
  TransactionBuilder,
  Transaction,
  Operation,
  Networks,
  Memo,
  Horizon,
} from "@stellar/stellar-sdk";
import dotenv from "dotenv";

dotenv.config();

export class StellarService {
  private server: Horizon.Server;
  private keypair: Keypair;
  private network: string;
  private readonly MAX_RETRIES = 3;
  private readonly FEE_INCREMENT_PERCENTAGE = 0.5; // 50% increase each retry
  private readonly RETRY_DELAY_MS = 2000; // 2 seconds delay between retries

  constructor() {
    const secret = process.env.ORACLE_SECRET_KEY || process.env.SOROBAN_ADMIN_SECRET;
    if (!secret) {
      throw new Error("Stellar secret key not found in environment variables");
    }

    this.keypair = Keypair.fromSecret(secret);
    this.network = process.env.STELLAR_NETWORK || "TESTNET";
    
    const horizonUrl = this.network === "PUBLIC" 
      ? "https://horizon.stellar.org" 
      : "https://horizon-testnet.stellar.org";
    
    this.server = new Horizon.Server(horizonUrl);
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
  async submitPriceUpdate(currency: string, price: number, memoId: string): Promise<string> {
    const baseFee = parseInt(await this.getRecommendedFee(), 10);
    
    const result = await this.submitTransactionWithRetries(
      (sourceAccount, currentFee) => {
        return new TransactionBuilder(sourceAccount, {
          fee: currentFee.toString(),
          networkPassphrase: this.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET,
        })
          .addOperation(
            Operation.manageData({
              name: `${currency}_PRICE`,
              value: price.toString(),
            })
          )
          .addMemo(Memo.text(memoId))
          .setTimeout(60)
          .build();
      },
      this.MAX_RETRIES,
      baseFee
    );
    
    console.info(`✅ Price update for ${currency} confirmed. Hash: ${result.hash}`);
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
    builderFn: (sourceAccount: Horizon.AccountResponse, currentFee: number) => Transaction,
    maxRetries = this.MAX_RETRIES,
    baseFee: number
  ): Promise<any> {
    let attempt = 0;
    
    while (attempt <= maxRetries) {
      try {
        const sourceAccount = await this.server.loadAccount(this.keypair.publicKey());
        const currentFee = Math.floor(baseFee * (1 + (this.FEE_INCREMENT_PERCENTAGE * attempt)));
        
        const transaction = builderFn(sourceAccount, currentFee);
        transaction.sign(this.keypair);
        
        return await this.server.submitTransaction(transaction);
      } catch (error: any) {
        attempt++;
        
        const isStuck = this.isStuckError(error);
        
        if (isStuck && attempt <= maxRetries) {
          console.warn(`⚠️ Transaction stuck or fee too low (Attempt ${attempt}). Bumping fee and retrying in ${this.RETRY_DELAY_MS}ms...`);
          await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS));
          continue;
        }

        throw error;
      }
    }
    
    throw new Error(`Failed to submit transaction after ${maxRetries + 1} attempts`);
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
      resultCode === 'tx_too_late' || 
      resultCode === 'tx_insufficient_fee' ||
      resultCode === 'tx_bad_seq' ||
      error.message?.includes('timeout') ||
      error.code === 'ECONNABORTED'
    );
  }

  /**
   * Generate a unique ID for the transaction memo
   * Format: SF-<CURRENCY>-<TIMESTAMP>
   */
  generateMemoId(currency: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    // Stellar MemoText limit is 28 bytes
    const id = `SF-${currency}-${timestamp}-${random}`;
    return id.substring(0, 28);
  }
}
