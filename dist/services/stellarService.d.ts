import { Transaction, Horizon, Account } from "@stellar/stellar-sdk";
export declare class StellarService {
    private server;
    private network;
    private readonly MAX_RETRIES;
    private readonly FEE_INCREMENT_PERCENTAGE;
    private readonly RETRY_DELAY_MS;
    private readonly TRANSACTION_TIME_BOUND_SECONDS;
    private readonly pendingTimeBoundTransactions;
    constructor();
    /**
     * Returns the Stellar public key from the signer.
     */
    private getPublicKey;
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
    private assertStrictTimeBounds;
    private submitWithTimeoutListener;
    private registerPendingTimeBoundTransaction;
    private clearPendingTimeBoundTransaction;
    private isStuckError;
    private shouldRecycleImmediately;
    private isLocalTimeoutError;
    generateMemoId(currency: string): string;
}
//# sourceMappingURL=stellarService.d.ts.map