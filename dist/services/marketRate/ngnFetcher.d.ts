import { MarketRateFetcher, MarketRate } from "./types";
/**
 * NGN/XLM rate fetcher.
 *
 * Primary path uses VTpass {@link https://www.vtpass.com/documentation/variation-codes/ service-variations}
 * to read a configured variation's `variation_amount` as the Naira price for one unit of the underlying
 * SKU (configure a 1 USD/BUSD reference variation so `variation_amount` ≈ NGN per USD). That value is
 * multiplied by CoinGecko XLM/USD for NGN per XLM.
 *
 * Falls back to CoinGecko XLM/NGN directly, then XLM/USD × USD→NGN (open.er-api), matching other fetchers.
 */
export declare class NGNRateFetcher implements MarketRateFetcher {
    private readonly coinGeckoUrl;
    private readonly usdToNgnUrl;
    private vtpassBase;
    private vtpassHeaders;
    getCurrency(): string;
    private fetchNgnPerUsdFromVtpass;
    fetchRate(): Promise<MarketRate>;
    isHealthy(): Promise<boolean>;
}
//# sourceMappingURL=ngnFetcher.d.ts.map