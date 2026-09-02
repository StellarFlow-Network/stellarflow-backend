import { logger } from '../utils/logger';

export class OracleService {
  private static instance: OracleService;

  static getInstance(): OracleService {
    if (!OracleService.instance) {
      OracleService.instance = new OracleService();
    }
    return OracleService.instance;
  }

  async getPrice(asset: string): Promise<number> {
    try {
      const price = await this.getPriceFromCache(asset);
      if (price === null) {
        throw new Error(`Price not available for ${asset}`);
      }
      return price;
    } catch (error) {
      logger.error(`Failed to fetch price for ${asset}:`, error);
      throw error;
    }
  }

  async getMultiplePrices(assets: string[]): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    const uniqueAssets = [...new Set(assets)];

    for (const asset of uniqueAssets) {
      try {
        prices[asset] = await this.getPrice(asset);
      } catch {
        prices[asset] = 0;
      }
    }

    return prices;
  }

  private async getPriceFromCache(asset: string): Promise<number | null> {
    const mockPrices: Record<string, number> = {
      'XLM': 0.12,
      'USDC': 1.00,
      'NGN': 0.00062,
      'BTC': 30000.00,
      'ETH': 1800.00,
      'EURC': 1.05,
      'AQUA': 0.00001,
    };
    return mockPrices[asset] || null;
  }
}
