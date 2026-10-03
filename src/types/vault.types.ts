export interface Collateral {
  asset: string;
  amount: number;
  price: number;
  value: number;
}

export interface Debt {
  asset: string;
  amount: number;
  price: number;
  value: number;
}

export interface VaultPosition {
  accountId: string;
  totalCollateralValue: number;
  totalDebtValue: number;
  healthFactor: number;
  liquidationThreshold: number;
  status: "safe" | "warning" | "liquidation_risk";
  collateralBreakdown: Collateral[];
  debtBreakdown: Debt[];
}

export interface HealthFactorResponse {
  success: boolean;
  data?: VaultPosition;
  error?: string;
}

/**
 * Collateral liquidation Dutch auction quote (issue #1043).
 *
 * The auction opens at `startPrice` (110% of the oracle price) and decays
 * exponentially towards `floorPrice` over a fixed 30 minute window:
 * `P(t) = startPrice * e^(-k * t)` where `k` is `decayConstant`.
 */
export interface VaultAuctionPrice {
  asset: string;
  /** Oracle price the auction is denominated against. */
  oraclePrice: number;
  /** P(0) = oraclePrice * 1.10 */
  startPrice: number;
  /** Price at the end of the 30 minute window = oraclePrice * 0.50 */
  floorPrice: number;
  /** P(t) at `elapsedSeconds`. */
  currentPrice: number;
  /** Exponential decay constant `k` (per second). */
  decayConstant: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  durationSeconds: number;
}

export interface AuctionPriceResponse {
  success: boolean;
  data?: VaultAuctionPrice;
  error?: string;
}
