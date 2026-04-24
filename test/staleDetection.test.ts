import { intelligenceService } from "../src/services/intelligenceService";
import prisma from "../src/lib/prisma";

async function runTest() {
  console.log("🧪 Testing Stale Record Detection...\n");

  try {
    const staleCurrencies = await intelligenceService.getStaleCurrencies();
    console.log("Stale Currencies identified:", staleCurrencies);

    if (Array.isArray(staleCurrencies)) {
      console.log("✅ Test PASSED: Returned a list of currencies.");
    } else {
      console.log("❌ Test FAILED: Did not return an array.");
    }
  } catch (error) {
    console.error("❌ Test FAILED with error:", error);
  }
}

runTest();
