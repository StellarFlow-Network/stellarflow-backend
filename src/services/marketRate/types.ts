export interface MarketRate {
  currency: string;
  rate: number;
  timestamp: Date;
  source: string;
}

export interface MarketRateFetcher {
  getCurrency(): string;
  fetchRate(): Promise<MarketRate>;
  isHealthy(): Promise<boolean>;
}

export interface RateSource {
  name: string;
  url: string;
  apiKey?: string;
}

export interface FetcherResponse {
  success: boolean;
  data?: MarketRate;
  error?: string;
}
