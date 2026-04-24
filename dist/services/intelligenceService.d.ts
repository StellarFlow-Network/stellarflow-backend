export interface HourlyVolatilitySnapshotItem {
    currency: string;
    standardDeviation: number;
    sampleCount: number;
    meanRate: number | null;
    latestRate: number | null;
    latestTimestamp: Date | null;
}
export interface HourlyVolatilitySnapshot {
    windowMinutes: number;
    windowStart: Date;
    windowEnd: Date;
    generatedAt: Date;
    currencies: HourlyVolatilitySnapshotItem[];
}
export declare class IntelligenceService {
    private readonly db;
    constructor(db?: PrismaClient);
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
    /**
     * Builds a snapshot of per-currency price volatility over the last 60 minutes.
     * Volatility is represented as the population standard deviation of rates
     * recorded in PriceHistory during the lookback window.
     */
    getHourlyVolatilitySnapshot(now?: Date): Promise<HourlyVolatilitySnapshot>;
    private calculatePopulationStandardDeviation;
}
export declare const intelligenceService: IntelligenceService;
//# sourceMappingURL=intelligenceService.d.ts.map