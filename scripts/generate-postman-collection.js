#!/usr/bin/env node

/**
 * StellarFlow API Collection Generator
 *
 * This script generates a Postman collection from the StellarFlow backend API routes.
 * Run this script whenever API routes are updated to maintain the collection.
 *
 * Usage: npm run generate:postman
 * or: node scripts/generate-postman-collection.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = "{{base_url}}";
const API_KEY = "{{API_KEY}}";
const ADMIN_TOKEN = "{{ADMIN_TOKEN}}";

// Collection template
const collection = {
  info: {
    name: "StellarFlow Backend API",
    description:
      "Complete API collection for StellarFlow Backend - Oracle price feeds and multi-sig operations",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    version: "1.0.0",
  },
  auth: {
    type: "apikey",
    apikey: [
      { key: "key", value: "X-API-Key", type: "string" },
      { key: "value", value: API_KEY, type: "string" },
      { key: "in", value: "header", type: "string" },
    ],
  },
  variable: [
    { key: "base_url", value: "http://localhost:3000", type: "string" },
    { key: "api_key", value: "your-api-key-here", type: "string" },
    { key: "admin_token", value: "your-admin-token-here", type: "string" },
  ],
  item: [],
};

// Helper function to create request
function createRequest(method, url, description, options = {}) {
  const request = {
    method: method.toUpperCase(),
    header: options.headers || [],
    url: {
      raw: url,
      host: [BASE_URL.replace("{{base_url}}", "{{base_url}}")],
      path: url
        .replace(BASE_URL + "/", "")
        .split("/")
        .filter((p) => p && !p.includes("{")),
    },
  };

  if (options.body) {
    request.body = {
      mode: "raw",
      raw: JSON.stringify(options.body, null, 2),
    };
    request.header.push({
      key: "Content-Type",
      value: "application/json",
    });
  }

  if (options.auth) {
    request.header.push({
      key: "Authorization",
      value: `Bearer ${options.auth}`,
    });
  }

  return {
    name: options.name || description.split(" ").slice(0, 5).join(" "),
    request: {
      ...request,
      description,
    },
  };
}

// Health & Status endpoints
collection.item.push({
  name: "Health & Status",
  item: [
    createRequest(
      "GET",
      `${BASE_URL}/health`,
      "Check the overall health of the backend including database and Stellar Horizon connectivity",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/`,
      "Get information about available API endpoints",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/status`,
      "Returns DB health and last successful price sync time for dashboard indicators",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/metrics`,
      "Get application metrics and performance data",
    ),
  ],
});

// Market Rates endpoints
collection.item.push({
  name: "Market Rates",
  item: [
    createRequest(
      "GET",
      `${BASE_URL}/api/market-rates/rates`,
      "Get all available market rates",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/market-rates/rate/:currency`,
      "Get rate for specific currency",
      {
        variables: [
          {
            key: "currency",
            value: "NGN",
            description: "Currency code (e.g., NGN, KES, GHS)",
          },
        ],
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/market-rates/latest`,
      "Get the latest cached market rates",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/market-rates/currencies`,
      "Get list of supported currencies",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/market-rates/health`,
      "Check health of market rates service",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/market-rates/reviews/pending`,
      "Get all pending price reviews",
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/market-rates/reviews/:reviewId/approve`,
      "Approve a pending price review",
      {
        body: {
          reviewedBy: "admin@example.com",
          note: "Approved after verification",
        },
        variables: [
          { key: "reviewId", value: "1", description: "Review ID to approve" },
        ],
      },
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/market-rates/reviews/:reviewId/reject`,
      "Reject a pending price review",
      {
        body: {
          reviewedBy: "admin@example.com",
          note: "Rejected due to data inconsistency",
        },
        variables: [
          { key: "reviewId", value: "1", description: "Review ID to reject" },
        ],
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/market-rates/cache`,
      "Get cache status and statistics",
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/market-rates/cache/clear`,
      "Clear all market rates cache",
    ),
  ],
});

// Price History endpoints
collection.item.push({
  name: "Price History",
  item: [
    createRequest(
      "GET",
      `${BASE_URL}/api/history/:asset`,
      "Get price history for an asset within specified time range",
      {
        query: [
          {
            key: "range",
            value: "7d",
            description: "Time range: 1d, 7d, 30d, 90d",
          },
        ],
        variables: [
          {
            key: "asset",
            value: "NGN",
            description: "Asset code (e.g., GHS, NGN, KES)",
          },
        ],
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/history/:asset`,
      "Get price history for an asset within custom date range",
      {
        query: [
          {
            key: "from",
            value: "2024-01-01",
            description: "Start date (ISO 8601)",
          },
          {
            key: "to",
            value: "2024-01-07",
            description: "End date (ISO 8601)",
          },
        ],
        variables: [
          {
            key: "asset",
            value: "NGN",
            description: "Asset code (e.g., GHS, NGN, KES)",
          },
        ],
        name: "Get Asset History (Custom Date Range)",
      },
    ),
  ],
});

// Price Updates endpoints
collection.item.push({
  name: "Price Updates (Multi-Sig)",
  item: [
    createRequest(
      "POST",
      `${BASE_URL}/api/price-updates/multi-sig/request`,
      "Create a multi-sig price update request",
      {
        body: {
          priceReviewId: 123,
          currency: "NGN",
          rate: 0.0021,
          source: "NGNX",
          memoId: "memo-123",
        },
      },
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/price-updates/sign`,
      "Add signature to a multi-sig price update",
      {
        body: { multiSigPriceId: 456 },
        headers: [
          {
            key: "Authorization",
            value: `Bearer {{MULTI_SIG_AUTH_TOKEN}}`,
            description: "Multi-sig auth token if configured",
          },
        ],
      },
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/price-updates/multi-sig/:multiSigPriceId/request-signature`,
      "Request signature from remote server",
      {
        body: {
          remoteServerUrl:
            "https://remote-server.example.com/api/price-updates/sign",
        },
        variables: [
          {
            key: "multiSigPriceId",
            value: "456",
            description: "Multi-sig price ID",
          },
        ],
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/price-updates/multi-sig/:multiSigPriceId/status`,
      "Get status of multi-sig price update",
      {
        variables: [
          {
            key: "multiSigPriceId",
            value: "456",
            description: "Multi-sig price ID",
          },
        ],
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/price-updates/multi-sig/pending`,
      "Get all pending multi-sig price updates",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/price-updates/multi-sig/:multiSigPriceId/signatures`,
      "Get all signatures for approved multi-sig price",
      {
        variables: [
          {
            key: "multiSigPriceId",
            value: "456",
            description: "Multi-sig price ID",
          },
        ],
      },
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/price-updates/multi-sig/:multiSigPriceId/record-submission`,
      "Record that multi-sig price has been submitted to Stellar",
      {
        body: { memoId: "memo-123", stellarTxHash: "hash-123" },
        variables: [
          {
            key: "multiSigPriceId",
            value: "456",
            description: "Multi-sig price ID",
          },
        ],
      },
    ),
  ],
});

// Statistics endpoints
collection.item.push({
  name: "Statistics",
  item: [
    createRequest(
      "GET",
      `${BASE_URL}/api/stats/relayers`,
      "Get statistics for all relayers (oracle servers)",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/stats/volume`,
      "Get volume statistics for a specific date",
      {
        query: [
          {
            key: "date",
            value: "2024-01-15",
            description: "Target date in YYYY-MM-DD format (defaults to today)",
          },
        ],
      },
    ),
  ],
});

// Intelligence endpoints
collection.item.push({
  name: "Intelligence",
  item: [
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/intelligence/hourly-volatility`,
      "Get hourly volatility snapshot for all active currencies",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/intelligence/price-change/:currency`,
      "Get 24-hour price change percentage for a currency",
      {
        variables: [
          {
            key: "currency",
            value: "NGN",
            description: "Currency code (e.g., NGN, GHS, KES)",
          },
        ],
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/intelligence/stale`,
      "Get list of currencies not updated in the last 30 minutes",
    ),
  ],
});

// Assets endpoints
collection.item.push({
  name: "Assets",
  item: [
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/assets`,
      "Get list of all active currency assets",
    ),
  ],
});

// Derived Assets endpoints
collection.item.push({
  name: "Derived Assets",
  item: [
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/derived-assets/rate/:base/:quote`,
      "Get synthetic cross-rate between two currencies",
      {
        variables: [
          { key: "base", value: "NGN", description: "Base currency code" },
          { key: "quote", value: "GHS", description: "Quote currency code" },
        ],
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/derived-assets/ngn-ghs`,
      "Get synthetic NGN per 1 GHS rate",
    ),
  ],
});

// Sanity Check endpoints
collection.item.push({
  name: "Sanity Check",
  item: [
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/sanity-check/check/:currency`,
      "Perform sanity check for a specific currency",
      {
        variables: [
          {
            key: "currency",
            value: "NGN",
            description: "Currency code to check",
          },
        ],
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/sanity-check/check-all`,
      "Perform sanity check for all supported currencies",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/sanity-check/threshold`,
      "Get current sanity check deviation threshold",
    ),
  ],
});

// Cache Management endpoints
collection.item.push({
  name: "Cache Management",
  item: [
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/cache/metrics`,
      "Get cache performance metrics and statistics",
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/v1/cache/clear`,
      "Clear both L1 and L2 cache layers",
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/cache/health`,
      "Check health status of cache layers",
    ),
  ],
});

// System Control endpoints
collection.item.push({
  name: "System Control (Admin)",
  item: [
    createRequest(
      "POST",
      `${BASE_URL}/api/admin/system/halt`,
      "Initiate system halt requiring consensus approval",
      {
        body: {
          reason: "Emergency maintenance required",
          duration: 24,
          emergencyLevel: "HIGH",
        },
        auth: ADMIN_TOKEN,
      },
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/admin/system/upgrade`,
      "Initiate system upgrade requiring consensus approval",
      {
        body: {
          version: "2.1.0",
          upgradeType: "MINOR",
          scheduledAt: "2024-01-15T10:00:00Z",
          rollbackPlan: "Rollback to previous version",
          notes: "Feature enhancements",
        },
        auth: ADMIN_TOKEN,
      },
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/admin/system/consensus/:consensusId/signature`,
      "Add admin signature to consensus request",
      {
        body: { signature: "abcd1234567890..." },
        auth: ADMIN_TOKEN,
        variables: [
          {
            key: "consensusId",
            value: "123",
            description: "Consensus request ID",
          },
        ],
      },
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/admin/system/consensus/:consensusId/execute`,
      "Execute approved consensus request",
      {
        auth: ADMIN_TOKEN,
        variables: [
          {
            key: "consensusId",
            value: "123",
            description: "Consensus request ID",
          },
        ],
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/admin/system/consensus/pending`,
      "Get all pending consensus requests",
      {
        auth: ADMIN_TOKEN,
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/admin/system/consensus/:consensusId`,
      "Get detailed information about consensus request",
      {
        auth: ADMIN_TOKEN,
        variables: [
          {
            key: "consensusId",
            value: "123",
            description: "Consensus request ID",
          },
        ],
      },
    ),
  ],
});

// System Failover endpoints
collection.item.push({
  name: "System Failover",
  item: [
    createRequest(
      "POST",
      `${BASE_URL}/api/v1/system/failover`,
      "Manually switch active regional backend cluster",
      {
        body: { targetRegion: "SECONDARY" },
        auth: ADMIN_TOKEN,
      },
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/v1/system/failover/reset`,
      "Reset manual failover override to automatic logic",
      {
        auth: ADMIN_TOKEN,
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/system/failover`,
      "Get current regional failover status",
      {
        auth: ADMIN_TOKEN,
      },
    ),
  ],
});

// Admin Operations endpoints
collection.item.push({
  name: "Admin Operations",
  item: [
    createRequest(
      "GET",
      `${BASE_URL}/api/admin/reports/summary`,
      "Generate Oracle usage summary report",
      {
        auth: ADMIN_TOKEN,
        query: [
          {
            key: "format",
            value: "html",
            description: "Output format: html or pdf",
          },
          {
            key: "month",
            value: "2024-03",
            description: "Target month in YYYY-MM format",
          },
        ],
      },
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/admin/reload-secret`,
      "Reload Stellar secret key without restarting",
      {
        body: { secretKey: "S..." },
        auth: ADMIN_TOKEN,
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/admin/relayer-registry`,
      "Get all relayer registry entries",
      {
        auth: ADMIN_TOKEN,
      },
    ),
    createRequest(
      "GET",
      `${BASE_URL}/api/admin/relayer-registry/:relayerId`,
      "Get relayer registry entry by ID",
      {
        auth: ADMIN_TOKEN,
        variables: [
          { key: "relayerId", value: "1", description: "Relayer ID" },
        ],
      },
    ),
    createRequest(
      "PUT",
      `${BASE_URL}/api/admin/rate-limit`,
      "Update rate limiting configuration",
      {
        body: { windowMs: 900000, maxRequests: 100, enabled: true },
        auth: ADMIN_TOKEN,
      },
    ),
    createRequest(
      "POST",
      `${BASE_URL}/api/admin/rate-limit/whitelist/refresh`,
      "Force refresh IP whitelist cache",
      {
        auth: ADMIN_TOKEN,
      },
    ),
  ],
});

// Documentation endpoints
collection.item.push({
  name: "Documentation",
  item: [
    createRequest(
      "GET",
      `${BASE_URL}/api/v1/docs`,
      "Access Swagger/OpenAPI documentation",
    ),
  ],
});

// Write the collection to file
const outputPath = path.join(
  __dirname,
  "..",
  "postman",
  "StellarFlow_Backend_API.postman_collection.json",
);
fs.writeFileSync(outputPath, JSON.stringify(collection, null, 2));

console.log("✅ Postman collection generated successfully!");
console.log(`📁 Saved to: ${outputPath}`);
console.log(
  `📊 Total endpoints: ${collection.item.reduce((total, folder) => total + folder.item.length, 0)}`,
);
console.log(`📂 Total folders: ${collection.item.length}`);
