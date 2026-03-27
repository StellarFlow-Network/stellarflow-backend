import { Transaction, Horizon } from "@stellar/stellar-sdk";
export declare class StellarService {
    private server;
    private keypair;
    private network;
    private readonly MAX_RETRIES;
    private readonly FEE_INCREMENT_PERCENTAGE;
    private readonly RETRY_DELAY_MS;
    constructor();
    /**
     * Fetches the recommended transaction fee from Horizon fee_stats.
     * Uses p50 (median) of recent fees to avoid overpaying while ensuring inclusion.
     * @returns Recommended fee in stroops as a string (required by TransactionBuilder)
     */
    getRecommendedFee(): Promise<string>;
    /**
     * Submit a price update to the Stellar network with a unique memo ID.
     * Leverages submitTransactionWithRetries for automatic fee bumping if stuck.
     * @param currency - The currency code (e.g., "NGN", "KES")
     * @param price - The current price/rate
     * @param memoId - Unique ID for auditing
     */
    submitPriceUpdate(currency: string, price: number, memoId: string): Promise<string>;
    /**
     * Submit a multi-signed price update to the Stellar network.
     * Accepts signatures from multiple oracle servers.
     * @param currency - The currency code (e.g., "NGN", "KES")
     * @param price - The current price/rate
     * @param memoId - Unique ID for auditing
     * @param signatures - Array of signatures from different signers
     */
    submitMultiSignedPriceUpdate(currency: string, price: number, memoId: string, signatures: Array<{
        signerPublicKey: string;
        signature: string;
    }>): Promise<string>;
    /**
     * Generic method to submit a transaction with retries and automatic fee bumping.
     * Optimizes interaction with the network (including Soroban contracts) by handling congestion.
     * @param builderFn - Function that builds a new transaction for each attempt
     * @param maxRetries - Max number of retries
     * @param baseFee - The starting fee in stroops
     */
    submitTransactionWithRetries(builderFn: (sourceAccount: Horizon.AccountResponse, currentFee: number) => Transaction, maxRetries: number | undefined, baseFee: number): Promise<any>;
    /**
     * Submit a multi-signed transaction to the Stellar network.
     * Adds multiple signatures to the transaction before submission.
     * @param builderFn - Function that builds the transaction
     * @param signatures - Array of signatures with signer public keys
     * @param maxRetries - Max number of retries
     * @param baseFee - The starting fee in stroops
     */
    private submitMultiSignedTransaction;
    /**
     * Get the network passphrase for the current network.
     * Ensures proper network identification for multi-sig operations.
     */
    private getNetworkPassphrase;
    /**
     * Determines if a transaction error indicates it is "stuck" or needs a fee bump.
     */
    private isStuckError;
    /**
     * Generate a unique ID for the transaction memo
     * Format: SF-<CURRENCY>-<TIMESTAMP>
     */
    generateMemoId(currency: string): string;
}
//# sourceMappingURL=stellarService.d.ts.map