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
  status: 'safe' | 'warning' | 'liquidation_risk';
  collateralBreakdown: Collateral[];
  debtBreakdown: Debt[];
}

export interface HealthFactorResponse {
  success: boolean;
  data?: VaultPosition;
  error?: string;
}
