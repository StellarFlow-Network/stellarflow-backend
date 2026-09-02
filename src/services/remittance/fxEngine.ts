import { MarketRateService } from "../marketRate";
import { getRedisClient } from "../../lib/redis";

export interface FxQuoteRequest {
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: number;
  routeLiquidityScore?: number; // 0 to 1, default 0.8
}

export interface FxQuoteResponse {
  quoteId: string;
  sourceCurrency: string;
  targetCurrency: string;
  sourceAmount: number;
  exchangeRate: number;
  baseRate: number;
  feeMarginPercent: number;
  feeAmount: number;
  targetAmount: number;
  expiresAt: string;
  ttlSeconds: number;
  cached: boolean;
}

export class RemittanceFxEngine {
  private marketRateService: MarketRateService;
  private static readonly TTL_SECONDS = 60;

  constructor(marketRateService?: MarketRateService) {
    this.marketRateService = marketRateService ?? new MarketRateService();
  }

  /**
   * Calculates dynamic fee margin based on transaction size and route liquidity.
   */
  public calculateFeeMargin(sourceAmount: number, liquidityScore: number = 0.8): number {
    // Base fee margin: 1.5%
    let margin = 1.5;

    // Size adjustment: larger amounts get lower margins, micro amounts get higher
    if (sourceAmount > 10000) {
      margin -= 0.5;
    } else if (sourceAmount > 5000) {
      margin -= 0.3;
    } else if (sourceAmount < 100) {
      margin += 0.5;
    }

    // Liquidity adjustment: lower liquidity increases fee
    const boundedLiquidity = Math.max(0.1, Math.min(1.0, liquidityScore));
    if (boundedLiquidity < 0.5) {
      margin += (0.5 - boundedLiquidity) * 2.0;
    } else if (boundedLiquidity > 0.8) {
      margin -= 0.2;
    }

    // Clamp between 0.2% and 5.0%
    return Math.max(0.2, Math.min(5.0, Number(margin.toFixed(4))));
  }

  /**
   * Fetches raw exchange rate between two currency pairs (e.g., USD/NGN, EUR/KES, XLM/NGN).
   */
  public async getCorridorRate(sourceCurrency: string, targetCurrency: string): Promise<number> {
    const src = sourceCurrency.toUpperCase();
    const tgt = targetCurrency.toUpperCase();

    if (src === tgt) return 1.0;

    // If targeting XLM or sourced from XLM via marketRateService
    if (src === "XLM") {
      const res = await this.marketRateService.getRate(tgt);
      if (!res.success || !res.data) {
        throw new Error(`Unable to fetch rate for corridor ${src}/${tgt}: ${res.error ?? "unknown error"}`);
      }
      return Number(res.data.rate);
    }

    if (tgt === "XLM") {
      const res = await this.marketRateService.getRate(src);
      if (!res.success || !res.data) {
        throw new Error(`Unable to fetch rate for corridor ${src}/${tgt}: ${res.error ?? "unknown error"}`);
      }
      // Inverse since market rate is units per XLM
      const rate = Number(res.data.rate);
      if (rate <= 0) throw new Error(`Invalid rate for ${src}`);
      return 1 / rate;
    }

    // Synthetic cross rate via XLM base
    const srcToXlmRes = await this.marketRateService.getRate(src);
    const tgtToXlmRes = await this.marketRateService.getRate(tgt);

    if (!srcToXlmRes.success || !srcToXlmRes.data || !tgtToXlmRes.data) {
      throw new Error(`Unable to establish synthetic cross rate for ${src}/${tgt}`);
    }

    const srcPerXlm = Number(srcToXlmRes.data.rate);
    const tgtPerXlm = Number(tgtToXlmRes.data.rate);

    if (srcPerXlm <= 0 || tgtPerXlm <= 0) {
      throw new Error(`Invalid rates for synthetic corridor ${src}/${tgt}`);
    }

    // 1 XLM = srcPerXlm src => 1 src = (1/srcPerXlm) XLM
    // 1 XLM = tgtPerXlm tgt => 1 src = tgtPerXlm / srcPerXlm tgt
    return tgtPerXlm / srcPerXlm;
  }

  /**
   * Computes real-time FX quote with Redis caching (60s TTL).
   */
  public async getQuote(request: FxQuoteRequest): Promise<FxQuoteResponse> {
    const src = request.sourceCurrency.toUpperCase();
    const tgt = request.targetCurrency.toUpperCase();
    const amount = request.sourceAmount;

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Source amount must be greater than zero");
    }

    const cacheKey = `remittance:fx:quote:${src}:${tgt}:${amount}:${request.routeLiquidityScore ?? 0.8}`;
    const redis = getRedisClient();

    if (redis && redis.isOpen) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as FxQuoteResponse;
          return { ...parsed, cached: true };
        }
      } catch (err) {
        console.error("[RemittanceFxEngine] Redis cache read error:", err);
      }
    }

    const baseRate = await this.getCorridorRate(src, tgt);
    const feeMarginPercent = this.calculateFeeMargin(amount, request.routeLiquidityScore);
    
    // Apply fee margin reducing the effective exchange rate received by the customer
    const exchangeRate = baseRate * (1 - feeMarginPercent / 100);
    const feeAmount = amount * (feeMarginPercent / 100);
    const targetAmount = amount * exchangeRate;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + RemittanceFxEngine.TTL_SECONDS * 1000);

    const quoteId = `fx_q_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;

    const response: FxQuoteResponse = {
      quoteId,
      sourceCurrency: src,
      targetCurrency: tgt,
      sourceAmount: amount,
      exchangeRate,
      baseRate,
      feeMarginPercent,
      feeAmount,
      targetAmount,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: RemittanceFxEngine.TTL_SECONDS,
      cached: false,
    };

    if (redis && redis.isOpen) {
      try {
        await redis.set(cacheKey, JSON.stringify(response), {
          EX: RemittanceFxEngine.TTL_SECONDS,
        });
      } catch (err) {
        console.error("[RemittanceFxEngine] Redis cache write error:", err);
      }
    }

    return response;
  }
}
