export declare class IntelligenceService {
    /**
     * Calculates the 24-hour price change for a given currency.
     * Compares the latest rate with the rate from approximately 24 hours ago.
     *
     * @param currency - The currency code (e.g., "NGN", "GHS")
     * @returns A formatted string like "+2.5%" or "-1.2%"
     */
    calculate24hPriceChange(currency: string): Promise<string>;
    /**
     * Identifies currencies that haven't been updated in the database for over 30 minutes.
     *
     * @returns A list of currency codes that are "Out of Date"
     */
    getStaleCurrencies(): Promise<string[]>;
}
export declare const intelligenceService: IntelligenceService;
//# sourceMappingURL=intelligenceService.d.ts.map