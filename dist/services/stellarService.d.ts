import { Transaction, Horizon, Account } from "@stellar/stellar-sdk";
export declare class StellarService {
    private server;
    private network;
    private readonly MAX_RETRIES;
    private readonly FEE_INCREMENT_PERCENTAGE;
    private readonly RETRY_DELAY_MS;
    constructor();
    /**
     * Returns a Keypair derived from the currently active secret key.
     * Called at sign time so key rotations are reflected immediately.
     */
    private getKeypair;
    /**
     * Fetches the recommended transaction fee from Horizon fee_stats.
     */
    getRecommendedFee(): Promise<string>;
    /**
     * Submit a price update to the Stellar network.
     */
    submitPriceUpdate(currency: string, price: number, memoId: string): Promise<string>;
    /**
     * Submit multiple price updates in a single bundle.
     */
    submitBatchedPriceUpdates(updates: Array<{
        currency: string;
        price: number;
    }>, memoId: string): Promise<string>;
    /**
     * Submit a multi-signed price update.
     */
    submitMultiSignedPriceUpdate(currency: string, price: number, memoId: string, signatures: Array<{
        signerPublicKey: string;
        signature: string;
    }>): Promise<string>;
    /**
     * Generic method to submit a transaction with retries.
     */
    submitTransactionWithRetries(builderFn: (sourceAccount: Account | Horizon.AccountResponse, currentFee: number) => Transaction, maxRetries: number | undefined, baseFee: number): Promise<any>;
    /**
     * Submit a multi-signed transaction with retries.
     */
    private submitMultiSignedTransaction;
    private isStuckError;
    generateMemoId(currency: string): string;
}
//# sourceMappingURL=stellarService.d.ts.map