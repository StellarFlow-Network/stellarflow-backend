import axios from "axios";
import { calculateMedian } from "./types";
import { errorTracker } from "../errorTracker";
import { webhookService } from "../webhook";
export class GHSRateFetcher {
    coinGeckoUrl = "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=ghs,usd&include_last_updated_at=true";
    usdToGhsUrl = "https://open.er-api.com/v6/latest/USD";
    getCurrency() {
        return "GHS";
    }
    async fetchRate() {
        const prices = [];
        // Strategy 1: Try CoinGecko direct GHS price
        try {
            const coinGeckoResponse = await axios.get(this.coinGeckoUrl, {
                timeout: 10000,
                headers: {
                    "User-Agent": "StellarFlow-Oracle/1.0",
                },
            });
            const stellarPrice = coinGeckoResponse.data.stellar;
            if (stellarPrice &&
                typeof stellarPrice.ghs === "number" &&
                stellarPrice.ghs > 0) {
                const lastUpdatedAt = stellarPrice.last_updated_at
                    ? new Date(stellarPrice.last_updated_at * 1000)
                    : new Date();
                prices.push({
                    rate: stellarPrice.ghs,
                    timestamp: lastUpdatedAt,
                    source: "CoinGecko (direct)",
                });
                // Success - reset error tracker
                errorTracker.trackSuccess("GHS-price-fetch");
            }
        }
        catch (error) {
            console.debug("CoinGecko direct GHS price failed");
        }
        // Strategy 2: CoinGecko XLM/USD + ExchangeRate API
        try {
            const coinGeckoResponse = await axios.get(this.coinGeckoUrl, {
                timeout: 10000,
                headers: {
                    "User-Agent": "StellarFlow-Oracle/1.0",
                },
            });
            const stellarPrice = coinGeckoResponse.data.stellar;
            if (stellarPrice &&
                typeof stellarPrice.usd === "number" &&
                stellarPrice.usd > 0) {
                const exchangeRateResponse = await axios.get(this.usdToGhsUrl, {
                    timeout: 10000,
                    headers: {
                        "User-Agent": "StellarFlow-Oracle/1.0",
                    },
                });
                const usdToGhsRate = exchangeRateResponse.data.rates?.GHS;
                if (exchangeRateResponse.data.result === "success" &&
                    typeof usdToGhsRate === "number" &&
                    usdToGhsRate > 0) {
                    const fxTimestamp = exchangeRateResponse.data.time_last_update_unix
                        ? new Date(exchangeRateResponse.data.time_last_update_unix * 1000)
                        : new Date();
                    const lastUpdatedAt = stellarPrice.last_updated_at
                        ? new Date(stellarPrice.last_updated_at * 1000)
                        : new Date();
                    prices.push({
                        rate: stellarPrice.usd * usdToGhsRate,
                        timestamp: fxTimestamp > lastUpdatedAt ? fxTimestamp : lastUpdatedAt,
                        source: "CoinGecko + ExchangeRate API",
                    });
                    // Success - reset error tracker
                    errorTracker.trackSuccess("GHS-price-fetch");
                }
            }
        }
        catch (error) {
            console.debug("CoinGecko + ExchangeRate API failed");
        }
        // Strategy 3: Try alternative XLM pricing source
        try {
            const alternativeUrl = "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd";
            const altResponse = await axios.get(alternativeUrl, {
                timeout: 10000,
                headers: {
                    "User-Agent": "StellarFlow-Oracle/1.0",
                },
            });
            if (altResponse.data?.stellar?.usd) {
                const xlmUsd = parseFloat(altResponse.data.stellar.usd);
                if (!isNaN(xlmUsd) && xlmUsd > 0) {
                    const ghsResponse = await axios.get(this.usdToGhsUrl, {
                        timeout: 10000,
                        headers: {
                            "User-Agent": "StellarFlow-Oracle/1.0",
                        },
                    });
                    const ghsRate = ghsResponse.data.rates?.GHS;
                    if (ghsResponse.data.result === "success" &&
                        typeof ghsRate === "number" &&
                        ghsRate > 0) {
                        prices.push({
                            rate: xlmUsd * ghsRate,
                            timestamp: new Date(),
                            source: "Alternative XLM pricing",
                        });
                        // Success - reset error tracker
                        errorTracker.trackSuccess("GHS-price-fetch");
                    }
                }
            }
        }
        catch (error) {
            console.debug("Alternative XLM pricing source failed");
        }
        // If we have prices, calculate median
        if (prices.length > 0) {
            const rateValues = prices.map((p) => p.rate);
            const medianRate = calculateMedian(rateValues);
            const mostRecentTimestamp = prices.reduce((latest, p) => (p.timestamp > latest ? p.timestamp : latest), prices[0]?.timestamp ?? new Date());
            return {
                currency: "GHS",
                rate: medianRate,
                timestamp: mostRecentTimestamp,
                source: `Median of ${prices.length} sources`,
            };
        }
        // All strategies failed - track failure and send notification if 3 consecutive failures
        const error = new Error("All GHS rate sources failed");
        const thresholdReached = errorTracker.trackFailure("GHS-price-fetch", {
            errorMessage: error.message,
            timestamp: new Date(),
            service: "GHSRateFetcher",
        });
        if (thresholdReached) {
            await webhookService.sendErrorNotification({
                errorType: "PRICE_FETCH_FAILED_CONSECUTIVE",
                errorMessage: error.message,
                attempts: 3,
                service: "GHSRateFetcher",
                pricePair: "XLM/GHS",
                timestamp: new Date(),
            });
        }
        throw error;
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
//# sourceMappingURL=ghsFetcher.js.map