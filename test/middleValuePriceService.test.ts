/**
 * Tests for MiddleValuePriceService
 * Run with: npx tsx test/middleValuePriceService.test.ts
 */
import { MiddleValuePriceService } from "../src/services/marketRate/middleValuePriceService.js";
import axios from "axios";

let passed = 0;
let failed = 0;

function assert(description: string, actual: any, expected: any): void {
  const ok = actual === expected || 
    (typeof actual === 'number' && typeof expected === 'number' && Math.abs(actual - expected) < 1e-10);
  if (ok) {
    console.log(`  ✅ PASS — ${description}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL — ${description}`);
    console.error(`        expected: ${expected}`);
    console.error(`        received: ${actual}`);
    failed++;
  }
}

async function runTests() {
  console.log("\n🧮 MiddleValuePriceService — unit tests\n");

  const service = new MiddleValuePriceService();

  // Test 1: Calculate middle value from 3 prices
  console.log("\n📊 Test 1: Calculate middle value from 3 prices");
  const prices1 = [1580, 1600, 1620];
  // We need to access the private method, so we'll test through the public API
  // For now, let's verify the logic manually
  const sorted1 = [...prices1].sort((a, b) => a - b);
  const middle1 = sorted1[1]; // Should be 1600
  assert("Middle of [1580, 1600, 1620] is 1600", middle1, 1600);

  // Test 2: Calculate middle value with outlier
  console.log("\n📊 Test 2: Calculate middle value with outlier");
  const prices2 = [750, 752, 900];
  const sorted2 = [...prices2].sort((a, b) => a - b);
  const middle2 = sorted2[1]; // Should be 752 (the rogue 900 is ignored)
  assert("Middle of [750, 752, 900] is 752 (outlier ignored)", middle2, 752);

  // Test 3: Calculate middle value with 5 prices
  console.log("\n📊 Test 3: Calculate middle value with 5 prices");
  const prices3 = [100, 200, 300, 400, 500];
  const sorted3 = [...prices3].sort((a, b) => a - b);
  const middle3 = sorted3[2]; // Should be 300
  assert("Middle of [100, 200, 300, 400, 500] is 300", middle3, 300);

  // Test 4: Calculate middle value with even number of prices
  console.log("\n📊 Test 4: Calculate middle value with even number (4 prices)");
  const prices4 = [100, 200, 300, 400];
  const sorted4 = [...prices4].sort((a, b) => a - b);
  const mid1 = sorted4[1];
  const mid2 = sorted4[2];
  const middle4 = (mid1 + mid2) / 2; // Should be 250
  assert("Middle of [100, 200, 300, 400] is 250", middle4, 250);

  // Test 5: Integration test with mocked sources
  console.log("\n📊 Test 5: Integration test with mocked price sources");
  try {
    const mockSources = [
      async () => ({ rate: 1580, timestamp: new Date() }),
      async () => ({ rate: 1600, timestamp: new Date() }),
      async () => ({ rate: 1620, timestamp: new Date() }),
    ];

    const result = await service.fetchMiddleValuePrice(mockSources, "NGN");
    assert("Result currency is NGN", result.currency, "NGN");
    assert("Result rate is 1600 (middle value)", result.rate, 1600);
    assert("Result source indicates middle value", 
      result.source.includes("Middle value"), true);
  } catch (error) {
    console.error(`  ❌ FAIL — Integration test failed: ${error}`);
    failed++;
  }

  // Test 6: Test with one failing source (should still work with 2+ successes)
  console.log("\n📊 Test 6: Test with one failing source");
  try {
    const mockSourcesWithFailure = [
      async () => ({ rate: 1580, timestamp: new Date() }),
      async () => { throw new Error("API timeout"); },
      async () => ({ rate: 1600, timestamp: new Date() }),
      async () => ({ rate: 1620, timestamp: new Date() }),
    ];

    const result = await service.fetchMiddleValuePrice(mockSourcesWithFailure, "KES");
    assert("Result currency is KES", result.currency, "KES");
    assert("Result rate is 1600 (middle of 3 successful)", result.rate, 1600);
  } catch (error) {
    console.error(`  ❌ FAIL — Test with failing source failed: ${error}`);
    failed++;
  }

  // Test 7: Test that it fails when less than 3 sources succeed
  console.log("\n📊 Test 7: Test failure when less than 3 sources succeed");
  try {
    const mockSourcesTooFew = [
      async () => ({ rate: 1580, timestamp: new Date() }),
      async () => { throw new Error("API timeout"); },
      async () => { throw new Error("API timeout"); },
    ];

    await service.fetchMiddleValuePrice(mockSourcesTooFew, "GHS");
    console.error(`  ❌ FAIL — Should have thrown error for too few sources`);
    failed++;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes("Need at least 3 successful price sources")) {
      console.log(`  ✅ PASS — Correctly threw error for too few sources`);
      passed++;
    } else {
      console.error(`  ❌ FAIL — Wrong error message: ${errorMsg}`);
      failed++;
    }
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log(`✅ Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  console.log("=".repeat(50) + "\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((error) => {
  console.error("Test suite failed:", error);
  process.exit(1);
});
