import axios from 'axios';
import { MarketRateFetcher, MarketRate, RateSource } from './types';

export class GHSRateFetcher implements MarketRateFetcher {
  private readonly sources: RateSource[] = [
    {
      name: 'Bank of Ghana',
      url: 'https://www.bog.gov.gh/wp-json/tb/v1/rates'
    },
    {
      name: 'Ghana Cedi Rates',
      url: 'https://www.ghanacedi.com/api/rates'
    },
    {
      name: 'Open Exchange Rates',
      url: 'https://openexchangerates.org/api/latest.json?app_id=YOUR_API_KEY&symbols=GHS'
    }
  ];

  getCurrency(): string {
    return 'GHS';
  }

  async fetchRate(): Promise<MarketRate> {
    try {
      // Try Bank of Ghana first (most reliable)
      const bogRate = await this.fetchFromBOG();
      if (bogRate) {
        return bogRate;
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
      throw new Error(`Failed to fetch GHS rate: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async fetchFromBOG(): Promise<MarketRate | null> {
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

      // Bank of Ghana API returns rates in GHS per USD
      const rates = response.data;
      if (rates && rates.length > 0) {
        const latestRate = rates[0];
        return {
          currency: 'GHS',
          rate: parseFloat(latestRate.rate),
          timestamp: new Date(latestRate.date),
          source: this.sources[0].name
        };
      }

      return null;
    } catch (error) {
      console.warn('Bank of Ghana API failed:', error);
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
      const placeholderRate = 12.5; // Approximate GHS/USD rate
      
      return {
        currency: 'GHS',
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
