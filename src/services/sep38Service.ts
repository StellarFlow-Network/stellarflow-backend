import { getRedisClient } from "../lib/redis";
import { RemittanceFxEngine } from "./remittance/fxEngine";

export interface Sep38Quote {
  id: string;
  expires_at: string;
  sell_asset: string;
  sell_amount: string;
  buy_asset: string;
  buy_amount: string;
  price: string;
  total_price: string;
  fee: {
    total: string;
    asset: string;
    details: Array<{
      name: string;
      amount: string;
      description?: string;
    }>;
  };
}

export class Sep38Service {
  private fxEngine: RemittanceFxEngine;
  private static readonly QUOTE_TTL_SECONDS = 60;
  private static readonly PROTOCOL_FEE_PERCENT = 0.5; // F
  private static readonly ANCHOR_SPREAD_PERCENT = 1.0; // S

  constructor() {
    this.fxEngine = new RemittanceFxEngine();
  }

  public async getInfo() {
    // Return mock supported assets for SEP-38
    return {
      assets: [
        { asset: "iso4217:USD" },
        { asset: "iso4217:NGN" },
        { asset: "iso4217:KES" },
        { asset: "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
        { asset: "stellar:XLM" },
      ],
    };
  }

  public async getPrices(sellAsset: string, sellAmount: string, sellDeliveryMethod?: string, buyDeliveryMethod?: string, countryCode?: string) {
    // Simplified prices endpoint
    const buyAssets = ["iso4217:NGN", "iso4217:KES", "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "stellar:XLM"].filter(a => a !== sellAsset);
    
    const amount = Number(sellAmount) || 1.0;
    const prices = [];

    for (const buyAsset of buyAssets) {
      const srcCurrency = this.extractCurrency(sellAsset);
      const tgtCurrency = this.extractCurrency(buyAsset);
      try {
        const rate = await this.fxEngine.getCorridorRate(srcCurrency, tgtCurrency);
        prices.push({
          asset: buyAsset,
          price: (1 / rate).toFixed(7),
          decimals: 7,
        });
      } catch (e) {
        // skip if no rate
      }
    }
    return { buy_assets: prices };
  }

  public async getPrice(sellAsset: string, buyAsset: string, sellAmount?: string, buyAmount?: string) {
    const srcCurrency = this.extractCurrency(sellAsset);
    const tgtCurrency = this.extractCurrency(buyAsset);

    const rate = await this.fxEngine.getCorridorRate(srcCurrency, tgtCurrency);
    
    // S and F
    const spread = Sep38Service.ANCHOR_SPREAD_PERCENT / 100;
    const protocolFee = Sep38Service.PROTOCOL_FEE_PERCENT / 100;
    const totalFeePercent = spread + protocolFee;

    const exchangeRate = rate * (1 - totalFeePercent);
    const price = (1 / exchangeRate).toFixed(7);
    const totalPrice = price; // simple representation

    let sellAmt = Number(sellAmount);
    let buyAmt = Number(buyAmount);

    if (sellAmt) {
      buyAmt = sellAmt * exchangeRate;
    } else if (buyAmt) {
      sellAmt = buyAmt / exchangeRate;
    } else {
      sellAmt = 1.0;
      buyAmt = exchangeRate;
    }

    const feeAmount = (sellAmt * totalFeePercent).toFixed(4);

    return {
      price,
      total_price: totalPrice,
      sell_amount: sellAmt.toFixed(4),
      buy_amount: buyAmt.toFixed(4),
      fee: {
        total: feeAmount,
        asset: sellAsset,
        details: [
          {
            name: "Anchor Spread",
            amount: (sellAmt * spread).toFixed(4),
            description: "Anchor spread S",
          },
          {
            name: "Protocol Fee",
            amount: (sellAmt * protocolFee).toFixed(4),
            description: "Protocol fee F",
          }
        ],
      },
    };
  }

  public async postQuote(payload: any): Promise<Sep38Quote> {
    const { sell_asset, buy_asset, sell_amount, buy_amount } = payload;
    
    if (!sell_asset || !buy_asset || (!sell_amount && !buy_amount)) {
      throw new Error("Missing required parameters");
    }

    const priceDetails = await this.getPrice(sell_asset, buy_asset, sell_amount, buy_amount);
    
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Sep38Service.QUOTE_TTL_SECONDS * 1000);
    const quoteId = `sep38_q_${Math.random().toString(36).substring(2, 11)}_${Date.now()}`;

    const quote: Sep38Quote = {
      id: quoteId,
      expires_at: expiresAt.toISOString(),
      sell_asset,
      sell_amount: priceDetails.sell_amount,
      buy_asset,
      buy_amount: priceDetails.buy_amount,
      price: priceDetails.price,
      total_price: priceDetails.total_price,
      fee: priceDetails.fee,
    };

    const redis = getRedisClient();
    if (redis && redis.isOpen) {
      const lockKey = `sep38:quote:lock:${quoteId}`;
      await redis.set(lockKey, JSON.stringify(quote), {
        EX: Sep38Service.QUOTE_TTL_SECONDS,
      });
    }

    return quote;
  }

  public async getQuote(id: string): Promise<Sep38Quote | null> {
    const redis = getRedisClient();
    if (redis && redis.isOpen) {
      const lockKey = `sep38:quote:lock:${id}`;
      const data = await redis.get(lockKey);
      if (data) {
        return JSON.parse(data) as Sep38Quote;
      }
    }
    return null;
  }

  private extractCurrency(asset: string): string {
    if (asset.startsWith("iso4217:")) {
      return asset.split(":")[1];
    }
    if (asset.startsWith("stellar:")) {
      const parts = asset.split(":");
      return parts.length >= 2 ? parts[1] : "XLM";
    }
    return asset;
  }
}
