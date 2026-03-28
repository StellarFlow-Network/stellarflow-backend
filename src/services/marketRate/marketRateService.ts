import {
  MarketRateFetcher,
  MarketRate,
  FetcherResponse,
  AggregatedFetcherResponse,
} from "./types";
import { KESRateFetcher } from "./kesFetcher";
import { GHSRateFetcher } from "./ghsFetcher";
import { NGNRateFetcher } from "./ngnFetcher";
import { StellarService } from "../stellarService";
import { multiSigService } from "../multiSigService";
import { getIO } from "../../lib/socket";
import prisma from "../../lib/prisma";
import dotenv from "dotenv";
import { normalizeDateToUTC } from "../../utils/timeUtils";

dotenv.config();

// Global import for priceReviewService
import { priceReviewService } from "../priceReviewService";

export class MarketRateService {
  private fetchers: Map<string, MarketRateFetcher> = new Map();
  private cache: Map<string, { rate: MarketRate; expiry: Date }> = new Map();
  private stellarService: StellarService;
  private readonly CACHE_DURATION_MS = 30000; // 30 seconds
  private multiSigEnabled: boolean;
  private remoteOracleServers: string[] = [];

  constructor() {
    this.stellarService = new StellarService();
    
    // Check if multi-sig is enabled
    this.multiSigEnabled = process.env.MULTI_SIG_ENABLED === "true";
    
    // Parse remote oracle server URLs
    const remoteServersEnv = process.env.REMOTE_ORACLE_SERVERS || "";
    if (remoteServersEnv) {
      this.remoteOracleServers = remoteServersEnv
        .split(",")
        .map((url) => url.trim())
        .filter((url) => url.length > 0);
    }

    if (this.multiSigEnabled) {
      console.info(
        `[MarketRateService] Multi-Sig mode ENABLED with ${this.remoteOracleServers.length} remote servers`
      );
    }

    this.initializeFetchers();
  }

  private initializeFetchers(): void {
    const kesFetcher = new KESRateFetcher();
    const ghsFetcher = new GHSRateFetcher();
    const ngnFetcher = new NGNRateFetcher();

    this.fetchers.set("KES", kesFetcher);
    this.fetchers.set("GHS", ghsFetcher);
    this.fetchers.set("NGN", ngnFetcher);
  }

  async getRate(currency: string): Promise<FetcherResponse> {
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
      } catch (fetchError) {
        // Log provider/fetcher failure to ErrorLog (non-blocking)
        try {
          const providerName =
            fetcher && typeof (fetcher as any).constructor === "function"
              ? (fetcher as any).constructor.name
              : normalizedCurrency;
          try {
            const clientAny = prisma as any;
            if (clientAny?.errorLog && typeof clientAny.errorLog.create === "function") {
              clientAny.errorLog.create({
                data: {
                  providerName,
                  errorMessage:
                    fetchError instanceof Error
                      ? fetchError.message
                      : JSON.stringify(fetchError),
                  occurredAt: new Date(),
                },
              }).catch(() => {});
            }
          } catch {
            // swallow
          }
        } catch {
          // swallow any unexpected errors when attempting to log
        }

        return {
          success: false,
          error:
            fetchError instanceof Error
              ? fetchError.message
              : "Unknown fetcher error",
        };
      }
      const normalizedRate: MarketRate = {
        ...rate,
        timestamp: normalizeDateToUTC(rate.timestamp),
        comparisonTimestamp: rate.comparisonTimestamp
          ? normalizeDateToUTC(rate.comparisonTimestamp)
          : undefined,
      };
      const reviewAssessment = await priceReviewService.assessRate(normalizedRate);
      const enrichedRate: MarketRate = {
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
          const memoId = this.stellarService.generateMemoId(normalizedCurrency);

          if (this.multiSigEnabled) {
            // Multi-sig workflow: create request and collect signatures
            console.info(
              `[MarketRateService] Starting multi-sig workflow for ${normalizedCurrency} rate ${rate.rate}`
            );

            const signatureRequest = await multiSigService.createMultiSigRequest(
              reviewAssessment.reviewRecordId,
              normalizedCurrency,
              rate.rate,
              rate.source,
              memoId
            );

            // Sign locally first
            try {
              await multiSigService.signMultiSigPrice(signatureRequest.multiSigPriceId);
              console.info(
                `[MarketRateService] Local signature added for multi-sig request ${signatureRequest.multiSigPriceId}`
              );
            } catch (error) {
              console.error(
                `[MarketRateService] Failed to sign locally:`,
                error
              );
            }

            // Request signatures from remote servers asynchronously
            // (non-blocking - don't wait for completion)
            this.requestRemoteSignaturesAsync(
              signatureRequest.multiSigPriceId,
              memoId
            ).catch((err) => {
              console.error(
                `[MarketRateService] Error requesting remote signatures:`,
                err
              );
            });

            // Mark as multi-sig pending (don't submit to Stellar yet)
            // The submission will happen via a background job once all signatures are collected
            enrichedRate.contractSubmissionSkipped = false;
            enrichedRate.pendingMultiSig = true;
            enrichedRate.multiSigPriceId = signatureRequest.multiSigPriceId;
          } else {
            // Single-sig workflow: submit directly to Stellar
            const txHash = await this.stellarService.submitPriceUpdate(
              normalizedCurrency,
              rate.rate,
              memoId
            );
            await priceReviewService.markContractSubmitted(
              reviewAssessment.reviewRecordId,
              memoId,
              txHash
            );
            console.info(
              `[MarketRateService] Single-sig price update submitted for ${normalizedCurrency}`
            );
          }
        } catch (stellarError) {
          console.error(
            "Failed to submit price update to Stellar network:",
            stellarError
          );
        }
      } else {
        console.warn(
          `Manual review required for ${normalizedCurrency} rate ${rate.rate}. Skipping contract submission.`
        );
      }

      this.cache.set(normalizedCurrency, {
        rate: enrichedRate,
        expiry: new Date(Date.now() + this.CACHE_DURATION_MS),
      });

      // Persist to price history for sparkline charts
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
      } catch (dbError) {
        console.error("Failed to persist price history:", dbError);
      }

      // Broadcast fresh price to all connected dashboard clients
      try {
        getIO().emit("price:update", {
          currency: normalizedCurrency,
          rate: enrichedRate,
        });

        if (reviewAssessment.manualReviewRequired) {
          getIO().emit("price:review_required", {
            currency: normalizedCurrency,
            rate: enrichedRate,
          });
        }
      } catch {
        // Socket not initialized yet (e.g. during tests) - skip silently
      }

      return {
        success: true,
        data: enrichedRate,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  async getAllRates(): Promise<FetcherResponse[]> {
    const currencies = Array.from(this.fetchers.keys());
    const promises = currencies.map((currency) => this.getRate(currency));

    return Promise.all(promises);
  }

  async healthCheck(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [currency, fetcher] of this.fetchers) {
      try {
        results[currency] = await fetcher.isHealthy();
      } catch {
        results[currency] = false;
      }
    }

    return results;
  }

  getSupportedCurrencies(): string[] {
    return Array.from(this.fetchers.keys());
  }

  async getLatestPrices(): Promise<AggregatedFetcherResponse> {
    const results = await this.getAllRates();

    const successfulRates = results
      .filter((result) => result.success && result.data)
      .map((result) => result.data as MarketRate);

    const errorMessages = results
      .filter((result) => !result.success)
      .map((result) => result.error)
      .filter((error): error is string => !!error);

    const allSuccessful =
      successfulRates.length > 0 && errorMessages.length === 0;

    return {
      success: allSuccessful,
      data: successfulRates,
      ...(errorMessages.length > 0 && { error: errorMessages[0] }),
      ...(errorMessages.length > 0 && { errors: errorMessages }),
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getPendingReviews() {
    return priceReviewService.getPendingReviews();
  }

  async approvePendingReview(
    reviewId: number,
    reviewedBy?: string,
    reviewNotes?: string,
  ) {
    const pendingReview = await priceReviewService.getPendingReviewById(reviewId);
    if (!pendingReview) {
      throw new Error(`Pending review ${reviewId} was not found`);
    }

    const memoId = this.stellarService.generateMemoId(pendingReview.currency);
    const txHash = await this.stellarService.submitPriceUpdate(
      pendingReview.currency,
      pendingReview.rate,
      memoId,
    );

    const approvedReview = await priceReviewService.approveReview({
      reviewId,
      memoId,
      stellarTxHash: txHash,
      ...(reviewedBy !== undefined && { reviewedBy }),
      ...(reviewNotes !== undefined && { reviewNotes }),
    });

    this.cache.delete(pendingReview.currency.toUpperCase());

    try {
      getIO().emit("price:review_resolved", {
        action: "approved",
        review: approvedReview,
      });
    } catch {
      // Socket not initialized yet (e.g. during tests) - skip silently
    }

    return approvedReview;
  }

  async rejectPendingReview(
    reviewId: number,
    reviewedBy?: string,
    reviewNotes?: string,
  ) {
    const rejectedReview = await priceReviewService.rejectReview({
      reviewId,
      ...(reviewedBy !== undefined && { reviewedBy }),
      ...(reviewNotes !== undefined && { reviewNotes }),
    });

    this.cache.delete(rejectedReview.currency.toUpperCase());

    try {
      getIO().emit("price:review_resolved", {
        action: "rejected",
        review: rejectedReview,
      });
    } catch {
      // Socket not initialized yet (e.g. during tests) - skip silently
    }

    return rejectedReview;
  }

  getCacheStatus(): Record<string, { cached: boolean; expiry?: Date }> {
    const status: Record<string, { cached: boolean; expiry?: Date }> = {};

    for (const currency of this.fetchers.keys()) {
      const cached = this.cache.get(currency);
      if (cached && cached.expiry > new Date()) {
        status[currency] = {
          cached: true,
          expiry: cached.expiry,
        };
      } else {
        status[currency] = {
          cached: false,
        };
      }
    }

    return status;
  }

  /**
   * Asynchronously request signatures from remote oracle servers.
   * This is non-blocking and doesn't wait for completion.
   * Errors are logged but don't fail the price fetch operation.
   */
  private async requestRemoteSignaturesAsync(
    multiSigPriceId: number,
    memoId: string
  ): Promise<void> {
    console.info(
      `[MarketRateService] Requesting signatures from ${this.remoteOracleServers.length} remote servers for multi-sig ${multiSigPriceId}`
    );

    // Request signatures from all remote servers in parallel
    const signatureRequests = this.remoteOracleServers.map((serverUrl) =>
      multiSigService.requestRemoteSignature(multiSigPriceId, serverUrl)
    );

    const results = await Promise.allSettled(signatureRequests);

    // Log results for monitoring
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        if (result.value.success) {
          console.info(
            `[MarketRateService] ✅ Signature request sent to ${this.remoteOracleServers[index]}`
          );
        } else {
          console.warn(
            `[MarketRateService] ⚠️ Signature request failed for ${this.remoteOracleServers[index]}: ${result.value.error}`
          );
        }
      } else {
        console.error(
          `[MarketRateService] ❌ Error requesting signature from ${this.remoteOracleServers[index]}:`,
          result.reason
        );
      }
    });
  }
}

