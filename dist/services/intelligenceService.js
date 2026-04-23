import prisma from "../lib/prisma";
export class IntelligenceService {
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
            const latestRecord = await prisma.priceHistory.findFirst({
                where: { currency: asset },
                orderBy: { timestamp: "desc" },
            });
            if (!latestRecord) {
                return "0.0%";
            }
            // 2. Get the price record from approximately 24 hours ago
            // We look for the record closest to (but before or at) exactly 24h ago
            const historicalRecord = await prisma.priceHistory.findFirst({
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
                (await prisma.priceHistory.findFirst({
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
            const currenciesWithLatestUpdate = await prisma.currency.findMany({
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
}
export const intelligenceService = new IntelligenceService();
//# sourceMappingURL=intelligenceService.js.map