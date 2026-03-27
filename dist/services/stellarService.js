import { Keypair, TransactionBuilder, Operation, Networks, Memo, Horizon, } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
dotenv.config();
export class StellarService {
    server;
    keypair;
    network;
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
    async getRecommendedFee() {
        const feeStats = await this.server.feeStats();
        // p50 = median fee paid in recent ledgers — safe and cost-efficient
        const fee = parseInt(feeStats.fee_charged.p50, 10);
        return Math.max(fee, 100).toString(); // floor at Stellar's base fee (100 stroops)
    }
    /**
     * Submit a price update to the Stellar network with a unique memo ID
     * @param currency - The currency code (e.g., "NGN", "KES")
     * @param price - The current price/rate
     * @param memoId - Unique ID for auditing
     */
    async submitPriceUpdate(currency, price, memoId) {
        try {
            const sourceAccount = await this.server.loadAccount(this.keypair.publicKey());
            const fee = await this.getRecommendedFee();
            const transaction = new TransactionBuilder(sourceAccount, {
                fee,
                networkPassphrase: this.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET,
            })
                .addOperation(Operation.manageData({
                name: `${currency}_PRICE`,
                value: price.toString(),
            }))
                .addMemo(Memo.text(memoId))
                .setTimeout(180) // 3 minutes
                .build();
            transaction.sign(this.keypair);
            const result = await this.server.submitTransaction(transaction);
            console.info(`✅ Price update for ${currency} submitted to Stellar. Hash: ${result.hash}, Memo: ${memoId}`);
            return result.hash;
        }
        catch (error) {
            console.error(`❌ Failed to submit price update for ${currency}:`, error);
            throw error;
        }
    }
    /**
     * Generate a unique ID for the transaction memo
     * Format: SF-<CURRENCY>-<TIMESTAMP>
     */
    generateMemoId(currency) {
        const timestamp = Math.floor(Date.now() / 1000);
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        // Stellar MemoText limit is 28 bytes
        const id = `SF-${currency}-${timestamp}-${random}`;
        return id.substring(0, 28);
    }
}
//# sourceMappingURL=stellarService.js.map