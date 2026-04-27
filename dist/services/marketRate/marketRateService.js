import { KESRateFetcher } from "./kesFetcher";
import { GHSRateFetcher } from "./ghsFetcher";
import { NGNRateFetcher } from "./ngnFetcher";
import { StellarService } from "../stellarService";
import { multiSigService } from "../multiSigService";
import { broadcastToSessions } from "../../lib/socket";
import prisma from "../../lib/prisma";
import { getRedisClient } from "../../lib/redis";
import dotenv from "dotenv";
import { normalizeDateToUTC } from "../../utils/timeUtils";
import { sanityCheckService } from "../sanityCheckService";
import { appConfig } from "../../config/configWatcher";
import { isLockdownEnabled } from "../../state/appState";
dotenv.config();
import { priceReviewService } from "../priceReviewService";
export class MarketRateService {
    fetchers = new Map();
    cache = new Map();
    stellarService;
    LATEST_PRICES_REDIS_KEY = "market-rates:latest:v1";
    LATEST_PRICES_REDIS_TTL_SECONDS = 5;
    multiSigEnabled;
    remoteOracleServers = [];
    pendingSubmissions = [];
    batchTimeout = null;
    get CACHE_DURATION_MS() {
        return appConfig.cacheDurationMs;
    }
    get BATCH_WINDOW_MS() {
        return appConfig.batchWindowMs;
    }
    constructor() {
        this.stellarService = new StellarService();
        this.multiSigEnabled = process.env.MULTI_SIG_ENABLED === "true";
        const remoteServersEnv = process.env.REMOTE_ORACLE_SERVERS || "";
        if (remoteServersEnv) {
            this.remoteOracleServers = remoteServersEnv
                .split(",")
                .map((url) => url.trim())
                .filter((url) => url.length > 0);
        }
        if (this.multiSigEnabled) {
            console.info(`[MarketRateService] Multi-Sig mode ENABLED with ${this.remoteOracleServers.length} remote servers`);
        }
        this.initializeFetchers();
    }
    initializeFetchers() {
        this.fetchers.set("KES", new KESRateFetcher());
        this.fetchers.set("GHS", new GHSRateFetcher());
        this.fetchers.set("NGN", new NGNRateFetcher());
    }
    async getRate(currency) {
        try {
            const normalizedCurrency = currency.toUpperCase();
            const fetcher = this.fetchers.get(normalizedCurrency);
            if (!fetcher) {
                return {
                    success: false,
                    error: `No fetcher available for currency: ${currency}`,
                };
            }
            const cached = this.cache.get(normalizedCurrency);
            if (cached && cached.expiry > new Date()) {
                return {
                    success: true,
                    data: cached.rate,
                };
            }
            let rate;
            try {
                rate = await fetcher.fetchRate();
            }
            catch (fetchError) {
                try {
                    const providerName = fetcher && typeof fetcher.constructor === "function"
                        ? fetcher.constructor.name
                        : normalizedCurrency;
                    const clientAny = prisma;
                    if (clientAny?.errorLog &&
                        typeof clientAny.errorLog.create === "function") {
                        clientAny.errorLog
                            .create({
                            data: {
                                providerName,
                                errorMessage: fetchError instanceof Error
                                    ? fetchError.message
                                    : JSON.stringify(fetchError),
                                occurredAt: new Date(),
                            },
                        })
                            .catch(() => { });
                    }
                }
                catch {
                    // swallow logging errors
                }
                return {
                    success: false,
                    error: fetchError instanceof Error
                        ? fetchError.message
                        : "Unknown fetcher error",
                };
            }
            const normalizedRate = {
                ...rate,
                timestamp: normalizeDateToUTC(rate.timestamp),
                comparisonTimestamp: rate.comparisonTimestamp
                    ? normalizeDateToUTC(rate.comparisonTimestamp)
                    : undefined,
            };
            const reviewAssessment = await priceReviewService.assessRate(normalizedRate);
            const enrichedRate = {
                ...normalizedRate,
                manualReviewRequired: reviewAssessment.manualReviewRequired,
                reviewId: reviewAssessment.reviewRecordId,
                contractSubmissionSkipped: reviewAssessment.manualReviewRequired,
                ...(reviewAssessment.reason !== undefined && {
                    reviewReason: reviewAssessment.reason,
                }),
                ...(reviewAssessment.changePercent !== undefined && {
                    reviewChangePercent: reviewAssessment.changePercent,
                }),
                ...(reviewAssessment.comparisonRate !== undefined && {
                    comparisonRate: reviewAssessment.comparisonRate,
                }),
                ...(reviewAssessment.comparisonTimestamp !== undefined && {
                    comparisonTimestamp: reviewAssessment.comparisonTimestamp,
                }),
            };
            if (!reviewAssessment.manualReviewRequired) {
                try {
                    await sanityCheckService.checkPrice(normalizedCurrency, rate.rate);
                }
                catch (sanityError) {
                    console.warn(`Sanity check failed for ${normalizedCurrency}:`, sanityError);
                }
                if (await isLockdownEnabled()) {
                    enrichedRate.contractSubmissionSkipped = true;
                    console.warn(`[MarketRateService] Lockdown enabled. Skipping Stellar submission workflow for ${normalizedCurrency}.`);
                }
                else {
                    try {
                        const memoId = this.stellarService.generateMemoId(normalizedCurrency);
                        if (this.multiSigEnabled) {
                            console.info(`[MarketRateService] Starting multi-sig workflow for ${normalizedCurrency} rate ${rate.rate}`);
                            const signatureRequest = await multiSigService.createMultiSigRequest(reviewAssessment.reviewRecordId, normalizedCurrency, rate.rate, rate.source, memoId);
                            try {
                                await multiSigService.signMultiSigPrice(signatureRequest.multiSigPriceId);
                                console.info(`[MarketRateService] Local signature added for multi-sig request ${signatureRequest.multiSigPriceId}`);
                            }
                            catch (error) {
                                console.error(`[MarketRateService] Failed to sign locally:`, error);
                            }
                            this.requestRemoteSignaturesAsync(signatureRequest.multiSigPriceId, memoId).catch((err) => {
                                console.error(`[MarketRateService] Error requesting remote signatures:`, err);
                            });
                            enrichedRate.contractSubmissionSkipped = false;
                            enrichedRate.pendingMultiSig = true;
                            enrichedRate.multiSigPriceId =
                                signatureRequest.multiSigPriceId;
                        }
                        else {
                            const txHash = await this.stellarService.submitPriceUpdate(normalizedCurrency, rate.rate, memoId);
                            await priceReviewService.markContractSubmitted(reviewAssessment.reviewRecordId, memoId, txHash);
                            console.info(`[MarketRateService] Single-sig price update submitted for ${normalizedCurrency}`);
                            this.pendingSubmissions.push({
                                currency: normalizedCurrency,
                                rate: rate.rate,
                                reviewId: reviewAssessment.reviewRecordId,
                            });
                            if (!this.batchTimeout) {
                                this.batchTimeout = setTimeout(() => this.flushBatchSubmissions(), this.BATCH_WINDOW_MS);
                            }
                        }
                    }
                    catch (stellarError) {
                        console.error("Failed to submit price update to Stellar network:", stellarError);
                    }
                }
            }
            else {
                console.warn(`Manual review required for ${normalizedCurrency} rate ${rate.rate}. Skipping contract submission.`);
            }
            this.cache.set(normalizedCurrency, {
                rate: enrichedRate,
                expiry: new Date(Date.now() + this.CACHE_DURATION_MS),
            });
            try {
                const normalizedTimestamp = normalizeDateToUTC(enrichedRate.timestamp);
                await prisma.priceHistory.upsert({
                    where: {
                        currency_source_timestamp: {
                            currency: currency.toUpperCase(),
                            source: enrichedRate.source,
                            timestamp: normalizedTimestamp,
                        },
                    },
                    update: {},
                    create: {
                        currency: currency.toUpperCase(),
                        rate: enrichedRate.rate,
                        source: enrichedRate.source,
                        timestamp: normalizedTimestamp,
                    },
                });
            }
            catch (dbError) {
                console.error("Failed to persist price history:", dbError);
            }
            try {
                if (!reviewAssessment.manualReviewRequired) {
                    broadcastToSessions("price:update", {
                        currency: normalizedCurrency,
                        rate: enrichedRate.rate,
                        source: enrichedRate.source,
                        timestamp: enrichedRate.timestamp,
                    });
                }
                else {
                    broadcastToSessions("price:review_required", {
                        currency: normalizedCurrency,
                        rate: enrichedRate.rate,
                        reviewId: enrichedRate.reviewId,
                        reason: enrichedRate.reviewReason,
                    });
                }
            }
            catch {
                // Socket not initialized yet
            }
            return {
                success: true,
                data: enrichedRate,
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error occurred",
            };
        }
    }
    async getAllRates() {
        const currencies = Array.from(this.fetchers.keys());
        const promises = currencies.map((currency) => this.getRate(currency));
        return Promise.all(promises);
    }
    async flushBatchSubmissions() {
        this.batchTimeout = null;
        if (this.pendingSubmissions.length === 0)
            return;
        this.pendingSubmissions = [];
    }
    async healthCheck() {
        const results = {};
        for (const [currency, fetcher] of this.fetchers) {
            try {
                results[currency] = await fetcher.isHealthy();
            }
            catch {
                results[currency] = false;
            }
        }
        return results;
    }
    getSupportedCurrencies() {
        return Array.from(this.fetchers.keys());
    }
    getLatestPricesCacheClient() {
        const redisClient = getRedisClient();
        if (!redisClient || !redisClient.isReady) {
            return null;
        }
        return redisClient;
    }
    async fetchLatestPricesFromDatabase() {
        const rows = await prisma.priceHistory.findMany({
            where: {
                currency: {
                    in: this.getSupportedCurrencies(),
                },
            },
            distinct: ["currency"],
            orderBy: [{ currency: "asc" }, { timestamp: "desc" }],
        });
        return rows.map((row) => ({
            currency: row.currency,
            rate: Number(row.rate),
            timestamp: normalizeDateToUTC(row.timestamp),
            source: row.source,
        }));
    }
    parseLatestPricesCache(cachedPayload) {
        try {
            const parsed = JSON.parse(cachedPayload);
            if (typeof parsed.success !== "boolean") {
                return null;
            }
            const hydratedRates = Array.isArray(parsed.data)
                ? parsed.data.map((rate) => ({
                    ...rate,
                    timestamp: new Date(rate.timestamp),
                    ...(rate.comparisonTimestamp && {
                        comparisonTimestamp: new Date(rate.comparisonTimestamp),
                    }),
                }))
                : undefined;
            return {
                success: parsed.success,
                ...(hydratedRates && { data: hydratedRates }),
                ...(parsed.error && { error: parsed.error }),
                ...(parsed.errors && { errors: parsed.errors }),
            };
        }
        catch {
            return null;
        }
    }
    async getLatestPrices() {
        const cacheClient = this.getLatestPricesCacheClient();
        if (cacheClient) {
            try {
                const cachedPayload = await cacheClient.get(this.LATEST_PRICES_REDIS_KEY);
                if (cachedPayload) {
                    const cachedResponse = this.parseLatestPricesCache(cachedPayload);
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                }
            }
            catch (error) {
                console.warn("Failed to read latest prices from Redis cache:", error);
            }
        }
        try {
            const latestRates = await this.fetchLatestPricesFromDatabase();
            if (latestRates.length === 0) {
                return {
                    success: false,
                    error: "No latest prices available",
                };
            }
            const response = {
                success: true,
                data: latestRates,
            };
            if (cacheClient) {
                try {
                    await cacheClient.setEx(this.LATEST_PRICES_REDIS_KEY, this.LATEST_PRICES_REDIS_TTL_SECONDS, JSON.stringify(response));
                }
                catch (error) {
                    console.warn("Failed to write latest prices to Redis cache:", error);
                }
            }
            return response;
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error
                    ? error.message
                    : "Failed to fetch latest prices from database",
            };
        }
    }
    clearCache() {
        this.cache.clear();
        const cacheClient = this.getLatestPricesCacheClient();
        if (!cacheClient) {
            return;
        }
        void cacheClient.del(this.LATEST_PRICES_REDIS_KEY).catch((error) => {
            console.warn("Failed to clear latest prices Redis cache:", error);
        });
    }
    async getPendingReviews() {
        return priceReviewService.getPendingReviews();
    }
    async approvePendingReview(reviewId, reviewedBy, reviewNotes) {
        const pendingReview = await priceReviewService.getPendingReviewById(reviewId);
        if (!pendingReview) {
            throw new Error(`Pending review ${reviewId} was not found`);
        }
        const memoId = this.stellarService.generateMemoId(pendingReview.currency);
        const txHash = await this.stellarService.submitPriceUpdate(pendingReview.currency, pendingReview.rate, memoId);
        const approvedReview = await priceReviewService.approveReview({
            reviewId,
            memoId,
            stellarTxHash: txHash,
            ...(reviewedBy !== undefined && { reviewedBy }),
            ...(reviewNotes !== undefined && { reviewNotes }),
        });
        this.cache.delete(pendingReview.currency.toUpperCase());
        try {
            broadcastToSessions("price:review_resolved", {
                action: "approved",
                review: approvedReview,
            });
        }
        catch {
            // Socket not initialized yet
        }
        return approvedReview;
    }
    async rejectPendingReview(reviewId, reviewedBy, reviewNotes) {
        const rejectedReview = await priceReviewService.rejectReview({
            reviewId,
            ...(reviewedBy !== undefined && { reviewedBy }),
            ...(reviewNotes !== undefined && { reviewNotes }),
        });
        this.cache.delete(rejectedReview.currency.toUpperCase());
        try {
            broadcastToSessions("price:review_resolved", {
                action: "rejected",
                review: rejectedReview,
            });
        }
        catch {
            // Socket not initialized yet
        }
        return rejectedReview;
    }
    getCacheStatus() {
        const status = {};
        for (const currency of this.fetchers.keys()) {
            const cached = this.cache.get(currency);
            if (cached && cached.expiry > new Date()) {
                status[currency] = {
                    cached: true,
                    expiry: cached.expiry,
                };
            }
            else {
                status[currency] = {
                    cached: false,
                };
            }
        }
        return status;
    }
    async requestRemoteSignaturesAsync(multiSigPriceId, _memoId) {
        console.info(`[MarketRateService] Requesting signatures from ${this.remoteOracleServers.length} remote servers for multi-sig ${multiSigPriceId}`);
        const signatureRequests = this.remoteOracleServers.map((serverUrl) => multiSigService.requestRemoteSignature(multiSigPriceId, serverUrl));
        const results = await Promise.allSettled(signatureRequests);
        results.forEach((result, index) => {
            if (result.status === "fulfilled") {
                if (result.value.success) {
                    console.info(`[MarketRateService] ✅ Signature request sent to ${this.remoteOracleServers[index]}`);
                }
                else {
                    console.warn(`[MarketRateService] ⚠️ Signature request failed for ${this.remoteOracleServers[index]}: ${result.value.error}`);
                }
            }
            else {
                console.error(`[MarketRateService] ❌ Error requesting signature from ${this.remoteOracleServers[index]}:`, result.reason);
            }
        });
    }
}
//# sourceMappingURL=marketRateService.js.map