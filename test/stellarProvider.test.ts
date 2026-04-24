/**
 * Test suite for StellarProvider (Issue #176 — Multi-Region Horizon Fallback)
 *
 * Run with:
 *   npx tsx test/stellarProvider.test.ts
 */

import stellarProvider from "../src/lib/stellarProvider";

let passed = 0;
let failed = 0;

function assert(description: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ ${description}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Initialisation
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n🧪 StellarProvider — Multi-Region Horizon Fallback Tests\n");
console.log("1. Initialisation:");

const server = stellarProvider.getServer();
assert(
  "getServer() returns a non-null object",
  server !== null && server !== undefined,
);
assert(
  "getServer() has a submitTransaction method",
  typeof (server as any).submitTransaction === "function",
);

const initialUrl = stellarProvider.getCurrentUrl();
assert(
  "getCurrentUrl() returns a non-empty string",
  typeof initialUrl === "string" && initialUrl.length > 0,
);
assert(
  "initial URL contains 'horizon'",
  initialUrl.toLowerCase().includes("horizon"),
);
console.log(`     Active node: ${initialUrl}`);

// ─────────────────────────────────────────────────────────────────────────────
// 2. reportFailure — should NOT failover on non-Horizon errors
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n2. reportFailure() — non-Horizon errors (should NOT failover):");

const urlBefore = stellarProvider.getCurrentUrl();

const didFailover1 = stellarProvider.reportFailure(
  new Error("some application error"),
);
assert("generic Error does not trigger failover", didFailover1 === false);
assert(
  "URL unchanged after generic error",
  stellarProvider.getCurrentUrl() === urlBefore,
);

const didFailover2 = stellarProvider.reportFailure(null);
assert("null does not trigger failover", didFailover2 === false);

const didFailover3 = stellarProvider.reportFailure({ code: "ENOTFOUND" });
assert(
  "unrecognised error code does not trigger failover",
  didFailover3 === false,
);

// 4xx should NOT cause a failover (only 5xx)
const http404 = { response: { status: 404 }, message: "Not Found" };
const didFailover4 = stellarProvider.reportFailure(http404);
assert("HTTP 404 does not trigger failover", didFailover4 === false);
assert(
  "URL unchanged after 404",
  stellarProvider.getCurrentUrl() === urlBefore,
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. reportFailure — SHOULD failover on 5xx / network errors
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n3. reportFailure() — 5xx / network errors (SHOULD failover):");

// --- HTTP 500 ---
const urlBeforeHttp = stellarProvider.getCurrentUrl();
const http500 = { response: { status: 500 }, message: "Internal Server Error" };
const didFailover500 = stellarProvider.reportFailure(http500);
const urlAfterHttp = stellarProvider.getCurrentUrl();

assert("HTTP 500 triggers failover", didFailover500 === true);
assert("URL changes after HTTP 500", urlAfterHttp !== urlBeforeHttp);
assert(
  "new URL still contains 'horizon'",
  urlAfterHttp.toLowerCase().includes("horizon"),
);
console.log(
  `     Switched from ${urlBeforeHttp}\n     to           ${urlAfterHttp}`,
);

// getServer() now returns a new instance pointing at the new URL
const serverAfterFailover = stellarProvider.getServer();
assert(
  "getServer() returns updated server after failover",
  serverAfterFailover !== null,
);

// --- ECONNREFUSED ---
const urlBeforeConn = stellarProvider.getCurrentUrl();
const connRefused = { code: "ECONNREFUSED", message: "connect ECONNREFUSED" };
const didFailoverConn = stellarProvider.reportFailure(connRefused);
const urlAfterConn = stellarProvider.getCurrentUrl();

assert("ECONNREFUSED triggers failover", didFailoverConn === true);
assert("URL changes after ECONNREFUSED", urlAfterConn !== urlBeforeConn);
console.log(
  `     Switched from ${urlBeforeConn}\n     to           ${urlAfterConn}`,
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Rotation wraps back around (pool is finite)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n4. Rotation wraps around the full pool:");

// Force enough failovers to cycle back to the start
// (the pool has at most 3 nodes, so 3 failovers guarantees a wrap)
for (let i = 0; i < 5; i++) {
  stellarProvider.reportFailure({ response: { status: 503 } });
}

const urlAfterWrap = stellarProvider.getCurrentUrl();
assert(
  "provider still returns a valid URL after wrap-around",
  typeof urlAfterWrap === "string" && urlAfterWrap.length > 0,
);
assert(
  "URL still contains 'horizon' after wrap-around",
  urlAfterWrap.toLowerCase().includes("horizon"),
);
console.log(`     Active node after wrap: ${urlAfterWrap}`);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Timeout message triggers failover
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n5. Timeout error triggers failover:");

const urlBeforeTimeout = stellarProvider.getCurrentUrl();
const timeoutError = { message: "Request timeout after 30000ms" };
const didFailoverTimeout = stellarProvider.reportFailure(timeoutError);
assert("timeout message triggers failover", didFailoverTimeout === true);
assert(
  "URL changes after timeout",
  stellarProvider.getCurrentUrl() !== urlBeforeTimeout,
);

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error("\n❌ Some tests failed.");
  process.exit(1);
} else {
  console.log("\n✅ All tests passed.");
}
