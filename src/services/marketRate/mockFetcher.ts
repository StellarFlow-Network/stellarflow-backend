import { MarketRateFetcher, MarketRate } from "./types";

const MOCK_RATE_BASES: Record<string, { base: number; tolerance: number }> = {
  NGN: { base: 170, tolerance: 0.1 },
  KES: { base: 16, tolerance: 0.12 },
  GHS: { base: 1.4, tolerance: 0.16 },
};

function randomRate(base: number, tolerance: number): number {
  const min = base * (1 - tolerance);
  const max = base * (1 + tolerance);
  return Number((Math.random() * (max - min) + min).toFixed(4));
}

export class MockRateFetcher implements MarketRateFetcher {
  private readonly currency: string;

  constructor(currency: string) {
    this.currency = currency.toUpperCase();
  }

  getCurrency(): string {
    return this.currency;
  }

  async fetchRate(): Promise<MarketRate> {
    const config = MOCK_RATE_BASES[this.currency];
    if (!config) {
      throw new Error(`Mock fetcher does not support currency ${this.currency}`);
    }

    return {
      currency: this.currency,
      rate: randomRate(config.base, config.tolerance),
      timestamp: new Date(),
      source: "Mock Market API (USE_MOCKS=true)",
    };
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }
}
