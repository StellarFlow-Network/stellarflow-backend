export declare class StellarService {
    private server;
    private keypair;
    private network;
    constructor();
    /**
     * Fetches the recommended transaction fee from Horizon fee_stats.
     * Uses p50 (median) of recent fees to avoid overpaying while ensuring inclusion.
     * @returns Recommended fee in stroops as a string (required by TransactionBuilder)
     */
    getRecommendedFee(): Promise<string>;
    /**
     * Submit a price update to the Stellar network with a unique memo ID
     * @param currency - The currency code (e.g., "NGN", "KES")
     * @param price - The current price/rate
     * @param memoId - Unique ID for auditing
     */
    submitPriceUpdate(currency: string, price: number, memoId: string): Promise<string>;
    /**
     * Generate a unique ID for the transaction memo
     * Format: SF-<CURRENCY>-<TIMESTAMP>
     */
    generateMemoId(currency: string): string;
}
//# sourceMappingURL=stellarService.d.ts.map