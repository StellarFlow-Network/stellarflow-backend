import { MarketRateService } from "../src/services/marketRate/marketRateService";
import { DerivedAssetService } from "../src/services/derivedAssetService";

async function testDerivedRates() {
  console.log("🧪 Testing Derived Asset Service...\n");

  const marketRateService = new MarketRateService();
  const derivedAssetService = new DerivedAssetService(marketRateService);

  // Test NGN/GHS calculation
  console.log("🇳🇬/🇬🇭 Calculating synthetic NGN/GHS rate...");
  try {
    const result = await derivedAssetService.getNGNGHSRate();
    console.log("NGN/GHS Result:", JSON.stringify(result, null, 2));

    if (result.success && result.data) {
      console.log("✅ Successfully calculated NGN/GHS rate.");
      console.log(`Rate: 1 GHS = ${result.data.rate} NGN`);
    } else {
      console.error("❌ Failed to calculate NGN/GHS rate:", result.error);
    }
  } catch (error) {
    console.error("❌ Error calculating NGN/GHS rate:", error);
  }
  console.log();

  // Test KES/NGN calculation
  console.log("🇰🇪/🇳🇬 Calculating synthetic KES/NGN rate...");
  try {
    const result = await derivedAssetService.getDerivedRate("KES", "NGN");
    console.log("KES/NGN Result:", JSON.stringify(result, null, 2));

    if (result.success && result.data) {
      console.log("✅ Successfully calculated KES/NGN rate.");
      console.log(`Rate: 1 NGN = ${result.data.rate} KES`);
    } else {
      console.error("❌ Failed to calculate KES/NGN rate:", result.error);
    }
  } catch (error) {
    console.error("❌ Error calculating KES/NGN rate:", error);
  }
}

testDerivedRates().catch(console.error);
