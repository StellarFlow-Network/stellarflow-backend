import axios from "axios";
import { OUTGOING_HTTP_TIMEOUT_MS } from "../../utils/httpTimeout";
import { withRetry } from "../../utils/retryUtil";
import { createFetcherLogger } from "../../utils/logger";
/**
 * KES/XLM rate fetcher using CoinGecko as primary source.
 */
export class KESRateFetcher {
    coinGeckoUrl = "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=kes&include_last_updated_at=true";
    logger = createFetcherLogger("KESRate");
    getCurrency() {
        return "KES";
    }
    async fetchRate() {
        try {
            const response = await withRetry(() => axios.get(this.coinGeckoUrl, {
                timeout: OUTGOING_HTTP_TIMEOUT_MS,
                headers: {
                    "User-Agent": "StellarFlow-Oracle/1.0",
                },
            }), { maxRetries: 3, retryDelay: 1000 });
            const stellarPrice = response.data.stellar;
            if (stellarPrice &&
                typeof stellarPrice.kes === "number" &&
                stellarPrice.kes > 0) {
                const lastUpdatedAt = stellarPrice.last_updated_at
                    ? new Date(stellarPrice.last_updated_at * 1000)
                    : new Date();
                return {
                    currency: "KES",
                    rate: stellarPrice.kes,
                    timestamp: lastUpdatedAt,
                    source: "CoinGecko (KES)",
                };
            }
            throw new Error("Invalid response from CoinGecko for KES");
        }
        catch (error) {
            this.logger.error("Failed to fetch KES rate", undefined, error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }
    async isHealthy() {
        try {
            const rate = await this.fetchRate();
            return rate.rate > 0;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=kesFetcher.js.map