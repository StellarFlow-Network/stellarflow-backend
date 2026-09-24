import prisma from "../lib/prisma";
import { MarketRateService } from "./marketRate/marketRateService";
import { DerivedAssetService } from "./derivedAssetService";

export const MAX_DEVIATION_BPS = 50;
export const DEFAULT_QUOTE_TTL_MS = 5 * 60 * 1000;

export interface FxQuoteResult {
  success: boolean;
  quoteId?: string;
  routeId: string;
  senderCurrency: string;
  receiverCurrency: string;
  inputAmount: number;
  outputAmount: number;
  rate: number;
  fee: number;
  slippageBps: number;
  liveFeedRate: number;
  feedSource: string;
  feedTimestamp: Date;
  rateDeviationBps: number;
  status: string;
  expiresAt: Date;
  error?: string;
}

export interface QuoteLockParams {
  quoteId: string;
}

export interface QuoteStatus {
  id: string;
  routeId: string;
  senderCurrency: string;
  receiverCurrency: string;
  inputAmount: number;
  outputAmount: number;
  rate: number;
  fee: number;
  slippageBps: number;
  liveFeedRate: number;
  feedSource: string;
  rateDeviationBps: number;
  status: string;
  expiresAt: Date;
  lockedAt: Date | null;
  executedAt: Date | null;
  createdAt: Date;
}

export class FxConversionService {
  private marketRateService: MarketRateService;
  private derivedAssetService: DerivedAssetService;

  constructor(
    marketRateService?: MarketRateService,
    derivedAssetService?: DerivedAssetService,
  ) {
    this.marketRateService = marketRateService ?? new MarketRateService();
    this.derivedAssetService =
      derivedAssetService ?? new DerivedAssetService(this.marketRateService);
  }

  async getLiveFeedRate(
    senderCurrency: string,
    receiverCurrency: string,
  ): Promise<{ rate: number; source: string; timestamp: Date } | null> {
    const base = senderCurrency.toUpperCase();
    const quote = receiverCurrency.toUpperCase();

    const derived = await this.derivedAssetService.getDerivedRate(base, quote);
    if (derived.success && derived.data) {
      return {
        rate: derived.data.rate,
        source: derived.data.source,
        timestamp: derived.data.timestamp,
      };
    }

    const primary = await this.marketRateService.getRate(base);
    if (primary.success && primary.data) {
      const secondary = await this.marketRateService.getRate(quote);
      if (secondary.success && secondary.data && secondary.data.rate !== 0) {
        return {
          rate: primary.data.rate / secondary.data.rate,
          source: `Synthetic (${primary.data.source} / ${secondary.data.source})`,
          timestamp:
            primary.data.timestamp < secondary.data.timestamp
              ? primary.data.timestamp
              : secondary.data.timestamp,
        };
      }
    }

    return null;
  }

  calculateDeviationBps(lockedRate: number, feedRate: number): number {
    if (feedRate === 0) return 0;
    return Math.round((Math.abs(lockedRate - feedRate) / feedRate) * 10_000);
  }

  calculateOutputAmount(
    inputAmount: number,
    rate: number,
    fee: number,
  ): number {
    return Math.max(0, inputAmount * rate - fee);
  }

  async requestQuote(
    routeId: string,
    inputAmount: number,
    options?: { quoteTtlMs?: number; userAddress?: string },
  ): Promise<FxQuoteResult> {
    try {
      if (inputAmount <= 0) {
        return {
          success: false,
          routeId,
          senderCurrency: "",
          receiverCurrency: "",
          inputAmount,
          outputAmount: 0,
          rate: 0,
          fee: 0,
          slippageBps: 0,
          liveFeedRate: 0,
          feedSource: "",
          feedTimestamp: new Date(),
          rateDeviationBps: 0,
          status: "FAILED",
          expiresAt: new Date(),
          error: "Input amount must be positive",
        };
      }

      const route = await prisma.paymentRoute.findUnique({
        where: { id: routeId },
      });

      if (!route) {
        return {
          success: false,
          routeId,
          senderCurrency: "",
          receiverCurrency: "",
          inputAmount,
          outputAmount: 0,
          rate: 0,
          fee: 0,
          slippageBps: 0,
          liveFeedRate: 0,
          feedSource: "",
          feedTimestamp: new Date(),
          rateDeviationBps: 0,
          status: "FAILED",
          expiresAt: new Date(),
          error: "Payment route not found",
        };
      }

      if (route.status !== "ACTIVE") {
        return {
          success: false,
          routeId,
          senderCurrency: route.senderCurrency,
          receiverCurrency: route.receiverCurrency,
          inputAmount,
          outputAmount: 0,
          rate: 0,
          fee: 0,
          slippageBps: 0,
          liveFeedRate: 0,
          feedSource: "",
          feedTimestamp: new Date(),
          rateDeviationBps: 0,
          status: "FAILED",
          expiresAt: new Date(),
          error: "Payment route is not active",
        };
      }

      const feed = await this.getLiveFeedRate(
        route.senderCurrency,
        route.receiverCurrency,
      );

      if (!feed) {
        return {
          success: false,
          routeId,
          senderCurrency: route.senderCurrency,
          receiverCurrency: route.receiverCurrency,
          inputAmount,
          outputAmount: 0,
          rate: 0,
          fee: 0,
          slippageBps: 0,
          liveFeedRate: 0,
          feedSource: "",
          feedTimestamp: new Date(),
          rateDeviationBps: 0,
          status: "FAILED",
          expiresAt: new Date(),
          error: "Unable to fetch live FX feed rate",
        };
      }

      const routeRate = Number(route.rate);
      const deviationBps = this.calculateDeviationBps(routeRate, feed.rate);

      if (deviationBps > MAX_DEVIATION_BPS) {
        return {
          success: false,
          routeId,
          senderCurrency: route.senderCurrency,
          receiverCurrency: route.receiverCurrency,
          inputAmount,
          outputAmount: 0,
          rate: routeRate,
          fee: Number(route.fee),
          slippageBps: route.slippageBps,
          liveFeedRate: feed.rate,
          feedSource: feed.source,
          feedTimestamp: feed.timestamp,
          rateDeviationBps: deviationBps,
          status: "FAILED",
          expiresAt: new Date(),
          error: `Rate deviation ${deviationBps} bps exceeds maximum ${MAX_DEVIATION_BPS} bps`,
        };
      }

      const routeFee = Number(route.fee);
      const outputAmount = this.calculateOutputAmount(
        inputAmount,
        routeRate,
        routeFee,
      );

      const ttlMs = options?.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
      const expiresAt = new Date(Date.now() + ttlMs);

      const quote = await prisma.fxQuote.create({
        data: {
          paymentRouteId: routeId,
          ...(options?.userAddress
            ? { userAddress: options.userAddress }
            : {}),
          senderCurrency: route.senderCurrency,
          receiverCurrency: route.receiverCurrency,
          inputAmount,
          outputAmount,
          rate: routeRate,
          fee: routeFee,
          slippageBps: route.slippageBps,
          liveFeedRate: feed.rate,
          feedSource: feed.source,
          feedTimestamp: feed.timestamp,
          rateDeviationBps: deviationBps,
          status: "PENDING",
          expiresAt,
        },
      });

      return {
        success: true,
        quoteId: quote.id,
        routeId,
        senderCurrency: route.senderCurrency,
        receiverCurrency: route.receiverCurrency,
        inputAmount,
        outputAmount,
        rate: routeRate,
        fee: routeFee,
        slippageBps: route.slippageBps,
        liveFeedRate: feed.rate,
        feedSource: feed.source,
        feedTimestamp: feed.timestamp,
        rateDeviationBps: deviationBps,
        status: "PENDING",
        expiresAt,
      };
    } catch (error) {
      return {
        success: false,
        routeId,
        senderCurrency: "",
        receiverCurrency: "",
        inputAmount,
        outputAmount: 0,
        rate: 0,
        fee: 0,
        slippageBps: 0,
        liveFeedRate: 0,
        feedSource: "",
        feedTimestamp: new Date(),
        rateDeviationBps: 0,
        status: "FAILED",
        expiresAt: new Date(),
        error:
          error instanceof Error ? error.message : "Failed to create FX quote",
      };
    }
  }

  async lockQuote(params: QuoteLockParams): Promise<FxQuoteResult> {
    try {
      const quote = await prisma.fxQuote.findUnique({
        where: { id: params.quoteId },
        include: { paymentRoute: true },
      });

      if (!quote) {
        return this.failedResult(params.quoteId, "", 0, "Quote not found");
      }

      if (quote.status !== "PENDING") {
        return this.failedResult(
          params.quoteId,
          quote.senderCurrency,
          Number(quote.inputAmount),
          `Quote is ${quote.status}, cannot lock`,
        );
      }

      if (new Date() > quote.expiresAt) {
        await prisma.fxQuote.update({
          where: { id: params.quoteId },
          data: { status: "EXPIRED" },
        });
        return this.failedResult(
          params.quoteId,
          quote.senderCurrency,
          Number(quote.inputAmount),
          "Quote has expired",
        );
      }

      const feed = await this.getLiveFeedRate(
        quote.senderCurrency,
        quote.receiverCurrency,
      );

      if (!feed) {
        return this.failedResult(
          params.quoteId,
          quote.senderCurrency,
          Number(quote.inputAmount),
          "Unable to verify rate against live feed",
        );
      }

      const currentDeviation = this.calculateDeviationBps(
        Number(quote.rate),
        feed.rate,
      );

      if (currentDeviation > MAX_DEVIATION_BPS) {
        return this.failedResult(
          params.quoteId,
          quote.senderCurrency,
          Number(quote.inputAmount),
          `Live rate deviation ${currentDeviation} bps exceeds threshold`,
        );
      }

      const updated = await prisma.fxQuote.update({
        where: { id: params.quoteId },
        data: {
          status: "LOCKED",
          lockedAt: new Date(),
          liveFeedRate: feed.rate,
          feedSource: feed.source,
          feedTimestamp: feed.timestamp,
          rateDeviationBps: currentDeviation,
        },
      });

      return {
        success: true,
        quoteId: updated.id,
        routeId: updated.paymentRouteId,
        senderCurrency: updated.senderCurrency,
        receiverCurrency: updated.receiverCurrency,
        inputAmount: Number(updated.inputAmount),
        outputAmount: Number(updated.outputAmount),
        rate: Number(updated.rate),
        fee: Number(updated.fee),
        slippageBps: updated.slippageBps,
        liveFeedRate: feed.rate,
        feedSource: feed.source,
        feedTimestamp: feed.timestamp,
        rateDeviationBps: currentDeviation,
        status: "LOCKED",
        expiresAt: updated.expiresAt,
      };
    } catch (error) {
      return {
        success: false,
        quoteId: params.quoteId,
        routeId: "",
        senderCurrency: "",
        receiverCurrency: "",
        inputAmount: 0,
        outputAmount: 0,
        rate: 0,
        fee: 0,
        slippageBps: 0,
        liveFeedRate: 0,
        feedSource: "",
        feedTimestamp: new Date(),
        rateDeviationBps: 0,
        status: "FAILED",
        expiresAt: new Date(),
        error: error instanceof Error ? error.message : "Failed to lock quote",
      };
    }
  }

  async markExecuted(quoteId: string): Promise<QuoteStatus | null> {
    const updated = await prisma.fxQuote.update({
      where: { id: quoteId },
      data: { status: "EXECUTED", executedAt: new Date() },
    });

    return this.toQuoteStatus(updated);
  }

  async getQuoteStatus(quoteId: string): Promise<QuoteStatus | null> {
    const quote = await prisma.fxQuote.findUnique({
      where: { id: quoteId },
    });

    if (!quote) return null;

    if (quote.status === "PENDING" && new Date() > quote.expiresAt) {
      await prisma.fxQuote.update({
        where: { id: quoteId },
        data: { status: "EXPIRED" },
      });
      quote.status = "EXPIRED";
    }

    return this.toQuoteStatus(quote);
  }

  async expireStaleQuotes(): Promise<number> {
    const result = await prisma.fxQuote.updateMany({
      where: {
        status: "PENDING",
        expiresAt: { lt: new Date() },
      },
      data: { status: "EXPIRED" },
    });

    return result.count;
  }

  private failedResult(
    quoteId: string,
    senderCurrency: string,
    inputAmount: number,
    error: string,
  ): FxQuoteResult {
    return {
      success: false,
      quoteId,
      routeId: "",
      senderCurrency,
      receiverCurrency: "",
      inputAmount,
      outputAmount: 0,
      rate: 0,
      fee: 0,
      slippageBps: 0,
      liveFeedRate: 0,
      feedSource: "",
      feedTimestamp: new Date(),
      rateDeviationBps: 0,
      status: "FAILED",
      expiresAt: new Date(),
      error,
    };
  }

  private toQuoteStatus(quote: {
    id: string;
    paymentRouteId: string;
    senderCurrency: string;
    receiverCurrency: string;
    inputAmount: unknown;
    outputAmount: unknown;
    rate: unknown;
    fee: unknown;
    slippageBps: number;
    liveFeedRate: unknown;
    feedSource: string;
    rateDeviationBps: number;
    status: string;
    expiresAt: Date;
    lockedAt: Date | null;
    executedAt: Date | null;
    createdAt: Date;
  }): QuoteStatus {
    return {
      id: quote.id,
      routeId: quote.paymentRouteId,
      senderCurrency: quote.senderCurrency,
      receiverCurrency: quote.receiverCurrency,
      inputAmount: Number(quote.inputAmount),
      outputAmount: Number(quote.outputAmount),
      rate: Number(quote.rate),
      fee: Number(quote.fee),
      slippageBps: quote.slippageBps,
      liveFeedRate: Number(quote.liveFeedRate),
      feedSource: quote.feedSource,
      rateDeviationBps: quote.rateDeviationBps,
      status: quote.status,
      expiresAt: quote.expiresAt,
      lockedAt: quote.lockedAt,
      executedAt: quote.executedAt,
      createdAt: quote.createdAt,
    };
  }
}
