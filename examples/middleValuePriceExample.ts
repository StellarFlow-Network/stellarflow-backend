/**
 * Example: Using MiddleValuePriceService with existing fetchers
 * 
 * This demonstrates how to integrate the MiddleValuePriceService
 * with the existing NGN, KES, and GHS fetchers to get more accurate
 * prices by waiting for 3 API responses and using the middle value.
 */

import { MiddleValuePriceService } from "../src/services/marketRate/middleValuePriceService.js";
import { NGNRateFetcher } from "../src/services/marketRate/ngnFetcher.js";

async function exampleWithNGN() {
  console.log("\n🇳🇬 Example: Fetching NGN rate using middle value of 3 sources\n");

  const middleValueService = new MiddleValuePriceService();
  const ngnFetcher = new NGNRateFetcher();

  // The NGN fetcher already uses multiple sources internally.
  // We can create 3 separate price source functions that query different APIs:
  
  const priceSources = [
    // Source 1: CoinGecko direct NGN
    async () => {
      const rate = await ngnFetcher.fetchRate();
      return { rate: rate.rate, timestamp: rate.timestamp };
    },
    
    // Source 2: ExchangeRate API (USD to NGN) * CoinGecko XLM/USD
    async () => {
      // This would be implemented by calling the specific APIs directly
      // For demonstration, we'll use a modified version of the NGN fetcher
      const rate = await ngnFetcher.fetchRate();
      return { rate: rate.rate * 1.02, timestamp: rate.timestamp }; // Simulated different source
    },
    
    // Source 3: VTpass + other exchange
    async () => {
      const rate = await ngnFetcher.fetchRate();
      return { rate: rate.rate * 0.98, timestamp: rate.timestamp }; // Simulated different source
    },
  ];

  try {
    const result = await middleValueService.fetchMiddleValuePrice(
      priceSources,
      "NGN",
      10000, // 10 second timeout
    );

    console.log("✅ Middle Value Price Result:");
    console.log(`   Currency: ${result.currency}`);
    console.log(`   Rate: ${result.rate}`);
    console.log(`   Source: ${result.source}`);
    console.log(`   Timestamp: ${result.timestamp.toISOString()}`);
  } catch (error) {
    console.error("❌ Failed to fetch middle value price:", error);
  }
}

async function exampleWithCustomSources() {
  console.log("\n💱 Example: Using custom API sources for any currency\n");

  const middleValueService = new MiddleValuePriceService();

  // Create 3 custom price sources using the helper methods
  const priceSources = [
    middleValueService.createCoinGeckoSource(
      "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=ngn",
      "ngn"
    ),
    
    middleValueService.createExchangeRateSource(
      "https://open.er-api.com/v6/latest/USD",
      "NGN"
    ),
    
    middleValueService.createCustomSource(
      "https://your-custom-api.com/rates/NGN",
      // Extract rate from response
      (data) => data.rate,
      // Extract timestamp from response (optional)
      (data) => new Date(data.timestamp)
    ),
  ];

  try {
    const result = await middleValueService.fetchMiddleValuePrice(
      priceSources,
      "NGN",
      15000, // 15 second timeout
    );

    console.log("✅ Custom Sources Result:");
    console.log(`   Currency: ${result.currency}`);
    console.log(`   Rate: ${result.rate}`);
    console.log(`   Source: ${result.source}`);
    console.log(`   Timestamp: ${result.timestamp.toISOString()}`);
  } catch (error) {
    console.error("❌ Failed to fetch from custom sources:", error);
  }
}

async function exampleComparison() {
  console.log("\n📊 Example: Comparing single source vs middle value approach\n");

  const ngnFetcher = new NGNRateFetcher();
  const middleValueService = new MiddleValuePriceService();

  try {
    // Method 1: Single fetcher (current approach)
    console.log("\n1️⃣  Single Fetcher Approach:");
    const singleResult = await ngnFetcher.fetchRate();
    console.log(`   Rate: ${singleResult.rate}`);
    console.log(`   Source: ${singleResult.source}`);

    // Method 2: Middle value of 3 sources (new approach)
    console.log("\n2️⃣  Middle Value Approach (3 sources):");
    const priceSources = [
      async () => {
        const rate = await ngnFetcher.fetchRate();
        return { rate: rate.rate, timestamp: rate.timestamp };
      },
      async () => {
        const rate = await ngnFetcher.fetchRate();
        return { rate: rate.rate * 1.01, timestamp: rate.timestamp }; // Simulated +1%
      },
      async () => {
        const rate = await ngnFetcher.fetchRate();
        return { rate: rate.rate * 0.99, timestamp: rate.timestamp }; // Simulated -1%
      },
    ];

    const middleResult = await middleValueService.fetchMiddleValuePrice(
      priceSources,
      "NGN"
    );
    console.log(`   Rate: ${middleResult.rate}`);
    console.log(`   Source: ${middleResult.source}`);

    console.log("\n✅ Benefit: The middle value approach reduces the impact of any single rogue API source!");
  } catch (error) {
    console.error("❌ Comparison failed:", error);
  }
}

// Run examples
async function main() {
  console.log("=".repeat(60));
  console.log("MiddleValuePriceService - Usage Examples");
  console.log("=".repeat(60));

  await exampleWithNGN();
  await exampleWithCustomSources();
  await exampleComparison();

  console.log("\n" + "=".repeat(60));
  console.log("Examples completed!");
  console.log("=".repeat(60) + "\n");
}

main().catch(console.error);
