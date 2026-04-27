import prisma from "../lib/prisma";
const HOURLY_VOLATILITY_WINDOW_MINUTES = 60;
export class IntelligenceService {
    db;
    constructor(db = prisma) {
        this.db = db;
    }
    /**
     * Calculates the 24-hour price change for a given currency.
     * Compares the latest rate with the rate from approximately 24 hours ago.
     *
     * @param currency - The currency code (e.g., "NGN", "GHS")
     * @returns A formatted string like "+2.5%" or "-1.2%"
     */
    async calculate24hPriceChange(currency) {
        const asset = currency.toUpperCase();
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        try {
            // 1. Get the latest price record
            const latestRecord = await this.db.priceHistory.findFirst({
                where: { currency: asset },
                orderBy: { timestamp: "desc" },
            });
            if (!latestRecord) {
                return "0.0%";
            }
            // 2. Get the price record from approximately 24 hours ago
            // We look for the record closest to (but before or at) exactly 24h ago
            const historicalRecord = await this.db.priceHistory.findFirst({
                where: {
                    currency: asset,
                    timestamp: {
                        lte: oneDayAgo,
                    },
                },
                orderBy: { timestamp: "desc" },
            });
            // If no record exists before 24h ago, try to find the earliest record available
            // but only if it's at least some reasonable time ago (e.g. 1h)
            const baseRecord = historicalRecord ||
                (await this.db.priceHistory.findFirst({
                    where: { currency: asset },
                    orderBy: { timestamp: "asc" },
                }));
            if (!baseRecord || baseRecord.id === latestRecord.id) {
                return "0.0%";
            }
            const currentPrice = Number(latestRecord.rate);
            const pastPrice = Number(baseRecord.rate);
            if (pastPrice <= 0) {
                return "0.0%";
            }
            const changePercent = ((currentPrice - pastPrice) / pastPrice) * 100;
            const sign = changePercent >= 0 ? "+" : "";
            return `${sign}${changePercent.toFixed(1)}%`;
        }
        catch (error) {
            console.error(`Error calculating 24h change for ${asset}:`, error);
            return "0.0%";
        }
    }
    /**
     * Identifies currencies that haven't been updated in the database for over 30 minutes.
     *
     * @returns A list of currency codes that are "Out of Date"
     */
    async getStaleCurrencies() {
        const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
        const now = new Date();
        const staleTime = new Date(now.getTime() - STALE_THRESHOLD_MS);
        try {
            // Fetch active currencies and their latest price history entry
            const currenciesWithLatestUpdate = await this.db.currency.findMany({
                where: { isActive: true },
                include: {
                    priceHistory: {
                        orderBy: { updatedAt: "desc" },
                        take: 1,
                    },
                },
            });
            const staleCurrencies = [];
            for (const c of currenciesWithLatestUpdate) {
                const latest = c.priceHistory[0];
                const hasNoHistory = !latest;
                const isOld = latest && new Date(latest.updatedAt) < staleTime;
                if (hasNoHistory || isOld) {
                    staleCurrencies.push(c.code);
                }
            }
            return staleCurrencies;
        }
        catch (error) {
            console.error("Error detecting stale currencies:", error);
            return [];
        }
    }
    /**
     * Builds a snapshot of per-currency price volatility over the last 60 minutes.
     * Volatility is represented as the population standard deviation of rates
     * recorded in PriceHistory during the lookback window.
     */
    async getHourlyVolatilitySnapshot(now = new Date()) {
        const windowEnd = new Date(now);
        const windowStart = new Date(windowEnd.getTime() - HOURLY_VOLATILITY_WINDOW_MINUTES * 60 * 1000);
        const activeCurrencies = await this.db.currency.findMany({
            where: { isActive: true },
            select: { code: true },
            orderBy: { code: "asc" },
        });
        const currencyCodes = activeCurrencies.map((currency) => currency.code);
        if (currencyCodes.length === 0) {
            return {
                windowMinutes: HOURLY_VOLATILITY_WINDOW_MINUTES,
                windowStart,
                windowEnd,
                generatedAt: new Date(windowEnd),
                currencies: [],
            };
        }
        const recentPrices = await this.db.priceHistory.findMany({
            where: {
                currency: {
                    in: currencyCodes,
                },
                timestamp: {
                    gte: windowStart,
                    lte: windowEnd,
                },
            },
            orderBy: [{ currency: "asc" }, { timestamp: "asc" }],
            select: {
                currency: true,
                rate: true,
                timestamp: true,
            },
        });
        const groupedRates = new Map();
        for (const row of recentPrices) {
            const entries = groupedRates.get(row.currency) ?? [];
            entries.push({
                rate: Number(row.rate),
                timestamp: row.timestamp,
            });
            groupedRates.set(row.currency, entries);
        }
        const currencies = currencyCodes.map((currency) => {
            const samples = groupedRates.get(currency) ?? [];
            const latestSample = samples.at(-1) ?? null;
            const rates = samples.map((sample) => sample.rate);
            const sampleCount = rates.length;
            const meanRate = sampleCount > 0
                ? rates.reduce((sum, rate) => sum + rate, 0) / sampleCount
                : null;
            return {
                currency,
                standardDeviation: sampleCount > 0
                    ? this.calculatePopulationStandardDeviation(rates, meanRate)
                    : 0,
                sampleCount,
                meanRate,
                latestRate: latestSample?.rate ?? null,
                latestTimestamp: latestSample?.timestamp ?? null,
            };
        });
        return {
            windowMinutes: HOURLY_VOLATILITY_WINDOW_MINUTES,
            windowStart,
            windowEnd,
            generatedAt: new Date(windowEnd),
            currencies,
        };
    }
    calculatePopulationStandardDeviation(values, mean) {
        if (values.length <= 1) {
            return 0;
        }
        const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
            values.length;
        return Math.sqrt(variance);
    }
}
export const intelligenceService = new IntelligenceService();
//# sourceMappingURL=intelligenceService.js.map