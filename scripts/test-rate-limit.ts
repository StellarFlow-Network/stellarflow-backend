#!/usr/bin/env tsx
/**
 * Test script for rate-limit functionality.
 *
 * Usage:
 *   tsx scripts/test-rate-limit.ts
 *
 * Tests:
 * 1. Rate limit enforcement (should get 429 after maxRequests)
 * 2. Admin API config retrieval
 * 3. Admin API config update
 * 4. Whitelist refresh
 */

import axios, { AxiosError } from "axios";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "test_api_key";
const ADMIN_KEY = process.env.ADMIN_API_KEY || "test_admin_key";

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  enabled: boolean;
}

async function testRateLimitEnforcement() {
  console.log("\n🧪 Test 1: Rate Limit Enforcement");
  console.log("Sending requests until rate limit is hit...");

  let successCount = 0;
  let rateLimitHit = false;

  for (let i = 1; i <= 105; i++) {
    try {
      const response = await axios.get(`${BASE_URL}/api/v1/status`, {
        headers: { "x-api-key": API_KEY },
      });

      if (response.status === 200) {
        successCount++;
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        console.log(
          `✅ Rate limit hit after ${successCount} requests (expected)`,
        );
        console.log(`   Response: ${JSON.stringify(error.response.data)}`);
        rateLimitHit = true;
        break;
      } else {
        console.error(`❌ Unexpected error on request ${i}:`, error);
        break;
      }
    }

    // Small delay to avoid overwhelming the server
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  if (!rateLimitHit && successCount >= 100) {
    console.log(`⚠️  Sent ${successCount} requests without hitting rate limit`);
    console.log(
      "   This may indicate rate limiting is disabled or whitelist is active",
    );
  }
}

async function testGetConfig() {
  console.log("\n🧪 Test 2: Get Rate-Limit Config");

  try {
    const response = await axios.get(`${BASE_URL}/api/admin/rate-limit`, {
      headers: {
        "x-api-key": API_KEY,
        "x-admin-key": ADMIN_KEY,
      },
    });

    console.log("✅ Config retrieved successfully:");
    console.log(`   ${JSON.stringify(response.data.rateLimit, null, 2)}`);
    return response.data.rateLimit as RateLimitConfig;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        `❌ Failed to get config: ${error.response?.status} ${error.response?.statusText}`,
      );
      console.error(`   ${JSON.stringify(error.response?.data)}`);
    } else {
      console.error("❌ Unexpected error:", error);
    }
    return null;
  }
}

async function testUpdateConfig(updates: Partial<RateLimitConfig>) {
  console.log("\n🧪 Test 3: Update Rate-Limit Config");
  console.log(`   Updates: ${JSON.stringify(updates)}`);

  try {
    const response = await axios.put(
      `${BASE_URL}/api/admin/rate-limit`,
      updates,
      {
        headers: {
          "x-api-key": API_KEY,
          "x-admin-key": ADMIN_KEY,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("✅ Config updated successfully:");
    console.log(`   ${JSON.stringify(response.data.rateLimit, null, 2)}`);
    return true;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        `❌ Failed to update config: ${error.response?.status} ${error.response?.statusText}`,
      );
      console.error(`   ${JSON.stringify(error.response?.data)}`);
    } else {
      console.error("❌ Unexpected error:", error);
    }
    return false;
  }
}

async function testWhitelistRefresh() {
  console.log("\n🧪 Test 4: Whitelist Cache Refresh");

  try {
    const response = await axios.post(
      `${BASE_URL}/api/admin/rate-limit/whitelist/refresh`,
      {},
      {
        headers: {
          "x-api-key": API_KEY,
          "x-admin-key": ADMIN_KEY,
        },
      },
    );

    console.log("✅ Whitelist refreshed successfully:");
    console.log(`   ${response.data.message}`);
    return true;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        `❌ Failed to refresh whitelist: ${error.response?.status} ${error.response?.statusText}`,
      );
      console.error(`   ${JSON.stringify(error.response?.data)}`);
    } else {
      console.error("❌ Unexpected error:", error);
    }
    return false;
  }
}

async function main() {
  console.log("🚀 Rate-Limit Test Suite");
  console.log(`   Base URL: ${BASE_URL}`);
  console.log(`   API Key: ${API_KEY.slice(0, 8)}...`);
  console.log(`   Admin Key: ${ADMIN_KEY.slice(0, 8)}...`);

  // Test 1: Rate limit enforcement
  await testRateLimitEnforcement();

  // Test 2: Get current config
  const currentConfig = await testGetConfig();

  // Test 3: Update config (reduce limit for faster testing)
  if (currentConfig) {
    await testUpdateConfig({ maxRequests: 10 });

    // Restore original config
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await testUpdateConfig(currentConfig);
  }

  // Test 4: Whitelist refresh
  await testWhitelistRefresh();

  console.log("\n✨ Test suite completed");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
