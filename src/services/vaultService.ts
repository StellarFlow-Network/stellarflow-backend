import { OracleService } from "./oracleService";
import {
  VaultPosition,
  VaultAuctionPrice,
  Collateral,
  Debt,
} from "../types/vault.types";
import { logger } from "../utils/logger";

/** Auctions open 10% above the oracle price: P_start = P_oracle * 1.10. */
export const AUCTION_START_PREMIUM = 1.1;
/** The Dutch auction decays over a 30 minute window. */
export const AUCTION_DURATION_SECONDS = 30 * 60;
/**
 * Price the curve reaches when the window elapses. Anchoring the decay to a
 * concrete terminal price is what pins down `k` in P(t) = P_start * e^(-kt):
 * k = ln(P_start / P_floor) / AUCTION_DURATION_SECONDS.
 */
export const AUCTION_END_PRICE_RATIO = 0.5;

export class VaultService {
  private static instance: VaultService;
  private oracleService: OracleService;

  private constructor() {
    this.oracleService = OracleService.getInstance();
  }

  static getInstance(): VaultService {
    if (!VaultService.instance) {
      VaultService.instance = new VaultService();
    }
    return VaultService.instance;
  }

  async getPosition(accountId: string): Promise<VaultPosition> {
    const collateralPositions = await this.getCollateralPositions(accountId);
    const debtPositions = await this.getDebtPositions(accountId);

    const collateralAssets = collateralPositions.map((p) => p.asset);
    const debtAssets = debtPositions.map((p) => p.asset);
    const allAssets = [...new Set([...collateralAssets, ...debtAssets])];

    const prices = await this.oracleService.getMultiplePrices(allAssets);

    const collateralBreakdown: Collateral[] = collateralPositions.map(
      (pos) => ({
        asset: pos.asset,
        amount: pos.amount,
        price: prices[pos.asset] || 0,
        value: pos.amount * (prices[pos.asset] || 0),
      }),
    );

    const debtBreakdown: Debt[] = debtPositions.map((pos) => ({
      asset: pos.asset,
      amount: pos.amount,
      price: prices[pos.asset] || 0,
      value: pos.amount * (prices[pos.asset] || 0),
    }));

    const totalCollateralValue = collateralBreakdown.reduce(
      (sum, c) => sum + c.value,
      0,
    );
    const totalDebtValue = debtBreakdown.reduce((sum, d) => sum + d.value, 0);

    const healthFactor = this.calculateHealthFactor(
      totalCollateralValue,
      totalDebtValue,
    );
    const status = this.getStatus(healthFactor);
    const liquidationThreshold = this.getLiquidationThreshold();

    return {
      accountId,
      totalCollateralValue,
      totalDebtValue,
      healthFactor,
      liquidationThreshold,
      status,
      collateralBreakdown,
      debtBreakdown,
    };
  }

  /**
   * Quote the collateral liquidation Dutch auction for `asset` (issue #1043).
   *
   * The auction opens at `P_start = P_oracle * 1.10` and decays along
   * `P(t) = P_start * e^(-k * t)` for a 30 minute window, where `k` is pinned
   * by anchoring the curve to the floor price at the end of that window.
   */
  async getAuctionPrice(
    asset: string,
    elapsedSeconds = 0,
  ): Promise<VaultAuctionPrice> {
    const oraclePrice = await this.oracleService.getPrice(asset);
    return this.buildAuctionQuote(asset, oraclePrice, elapsedSeconds);
  }

  /**
   * Pure price maths for the auction curve, kept separate from the oracle
   * lookup so it can be exercised directly.
   */
  buildAuctionQuote(
    asset: string,
    oraclePrice: number,
    elapsedSeconds: number,
  ): VaultAuctionPrice {
    if (!Number.isFinite(oraclePrice) || oraclePrice <= 0) {
      throw new Error(`Invalid oracle price for ${asset}: ${oraclePrice}`);
    }

    const { startPrice, floorPrice, decayConstant } =
      this.auctionCurve(oraclePrice);
    const elapsed = this.clampAuctionElapsed(elapsedSeconds);

    return {
      asset,
      oraclePrice,
      startPrice,
      floorPrice,
      currentPrice: startPrice * Math.exp(-decayConstant * elapsed),
      decayConstant,
      elapsedSeconds: elapsed,
      remainingSeconds: AUCTION_DURATION_SECONDS - elapsed,
      durationSeconds: AUCTION_DURATION_SECONDS,
    };
  }

  /** P(t) = P_start * e^(-k * t), with `t` clamped to the 30 minute window. */
  calculateAuctionPrice(oraclePrice: number, elapsedSeconds: number): number {
    const { startPrice, decayConstant } = this.auctionCurve(oraclePrice);
    return (
      startPrice *
      Math.exp(-decayConstant * this.clampAuctionElapsed(elapsedSeconds))
    );
  }

  /** P_start, P_floor and the decay constant `k` implied by the oracle price. */
  private auctionCurve(oraclePrice: number): {
    startPrice: number;
    floorPrice: number;
    decayConstant: number;
  } {
    const startPrice = oraclePrice * AUCTION_START_PREMIUM;
    const floorPrice = oraclePrice * AUCTION_END_PRICE_RATIO;
    const decayConstant =
      Math.log(startPrice / floorPrice) / AUCTION_DURATION_SECONDS;
    return { startPrice, floorPrice, decayConstant };
  }

  /** Auctions cannot start in the past or run past their window. */
  private clampAuctionElapsed(elapsedSeconds: number): number {
    if (!Number.isFinite(elapsedSeconds)) return 0;
    return Math.min(Math.max(elapsedSeconds, 0), AUCTION_DURATION_SECONDS);
  }

  async getCollateralPositions(
    accountId: string,
  ): Promise<{ asset: string; amount: number }[]> {
    return [
      { asset: "XLM", amount: 10000 },
      { asset: "USDC", amount: 500 },
    ];
  }

  async getDebtPositions(
    accountId: string,
  ): Promise<{ asset: string; amount: number }[]> {
    return [{ asset: "USDC", amount: 200 }];
  }

  calculateHealthFactor(collateralValue: number, debtValue: number): number {
    if (debtValue === 0) return Infinity;
    return collateralValue / debtValue;
  }

  getStatus(healthFactor: number): "safe" | "warning" | "liquidation_risk" {
    if (healthFactor >= 1.5) return "safe";
    if (healthFactor >= 1.1) return "warning";
    return "liquidation_risk";
  }

  getLiquidationThreshold(): number {
    return 1.1;
  }
}
