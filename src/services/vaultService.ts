import { OracleService } from './oracleService';
import { VaultPosition, Collateral, Debt } from '../types/vault.types';
import { logger } from '../utils/logger';

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

    const collateralAssets = collateralPositions.map(p => p.asset);
    const debtAssets = debtPositions.map(p => p.asset);
    const allAssets = [...new Set([...collateralAssets, ...debtAssets])];

    const prices = await this.oracleService.getMultiplePrices(allAssets);

    const collateralBreakdown: Collateral[] = collateralPositions.map(pos => ({
      asset: pos.asset,
      amount: pos.amount,
      price: prices[pos.asset] || 0,
      value: pos.amount * (prices[pos.asset] || 0),
    }));

    const debtBreakdown: Debt[] = debtPositions.map(pos => ({
      asset: pos.asset,
      amount: pos.amount,
      price: prices[pos.asset] || 0,
      value: pos.amount * (prices[pos.asset] || 0),
    }));

    const totalCollateralValue = collateralBreakdown.reduce((sum, c) => sum + c.value, 0);
    const totalDebtValue = debtBreakdown.reduce((sum, d) => sum + d.value, 0);

    const healthFactor = this.calculateHealthFactor(totalCollateralValue, totalDebtValue);
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

  async getCollateralPositions(accountId: string): Promise<{ asset: string; amount: number }[]> {
    return [
      { asset: 'XLM', amount: 10000 },
      { asset: 'USDC', amount: 500 },
    ];
  }

  async getDebtPositions(accountId: string): Promise<{ asset: string; amount: number }[]> {
    return [
      { asset: 'USDC', amount: 200 },
    ];
  }

  calculateHealthFactor(collateralValue: number, debtValue: number): number {
    if (debtValue === 0) return Infinity;
    return collateralValue / debtValue;
  }

  getStatus(healthFactor: number): 'safe' | 'warning' | 'liquidation_risk' {
    if (healthFactor >= 1.5) return 'safe';
    if (healthFactor >= 1.1) return 'warning';
    return 'liquidation_risk';
  }

  getLiquidationThreshold(): number {
    return 1.1;
  }
}
