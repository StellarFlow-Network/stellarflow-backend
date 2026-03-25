import axios from 'axios';
import { MarketRateFetcher, MarketRate, RateSource } from './types';

export class KESRateFetcher implements MarketRateFetcher {
  private readonly sources: RateSource[] = [
    {
      name: 'Central Bank of Kenya',
      url: 'https://www.centralbank.go.ke/wp-json/fx-rate/v1/rates'
    },
    {
      name: 'XE.com',
      url: 'https://www.xe.com/currencytables/?from=USD&to=KES'
    },
    {
      name: 'Open Exchange Rates',
      url: 'https://openexchangerates.org/api/latest.json?app_id=YOUR_API_KEY&symbols=KES'
    }
  ];

  getCurrency(): string {
    return 'KES';
  }

  async fetchRate(): Promise<MarketRate> {
    try {
      // Try Central Bank of Kenya first (most reliable)
      const cbkRate = await this.fetchFromCBK();
      if (cbkRate) {
        return cbkRate;
      }

      // Fallback to alternative sources
      for (const source of this.sources.slice(1)) {
        try {
          const rate = await this.fetchFromSource(source);
          if (rate) {
            return rate;
          }
        } catch (error) {
          console.warn(`Failed to fetch from ${source.name}:`, error);
          continue;
        }
      }

      throw new Error('All rate sources failed');
    } catch (error) {
      throw new Error(`Failed to fetch KES rate: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async fetchFromCBK(): Promise<MarketRate | null> {
    try {
      if (!this.sources[0]) {
        throw new Error('No rate sources configured');
      }
      
      const response = await axios.get(this.sources[0].url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'StellarFlow-Oracle/1.0'
        }
      });

      // CBK API returns rates in KES per USD
      const rates = response.data;
      if (rates && rates.length > 0) {
        const latestRate = rates[0];
        return {
          currency: 'KES',
          rate: parseFloat(latestRate.rate),
          timestamp: new Date(latestRate.date),
          source: this.sources[0].name
        };
      }

      return null;
    } catch (error) {
      console.warn('CBK API failed:', error);
      return null;
    }
  }

  private async fetchFromSource(source: RateSource): Promise<MarketRate | null> {
    try {
      // This is a placeholder implementation
      // In a real implementation, you would parse the specific API response format
      const response = await axios.get(source.url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'StellarFlow-Oracle/1.0'
        }
      });

      // Placeholder rate - in reality, you'd parse the actual response
      const placeholderRate = 130.5; // Approximate KES/USD rate
      
      return {
        currency: 'KES',
        rate: placeholderRate,
        timestamp: new Date(),
        source: source.name
      };
    } catch (error) {
      console.warn(`Failed to fetch from ${source.name}:`, error);
      return null;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const rate = await this.fetchRate();
      return rate !== null && rate.rate > 0;
    } catch (error) {
      return false;
    }
  }
}
