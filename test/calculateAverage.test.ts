/**
 * Unit tests for calculateAverage
 * Run with: npx tsx test/calculateAverage.test.ts
 */
import {
  calculateAverage,
  calculateWeightedAverage,
} from "../src/services/marketRate/types.js";

let passed = 0;
let failed = 0;

function assert(description: string, actual: number, expected: number): void {
  // Use a small epsilon for floating-point comparisons
  const ok = Math.abs(actual - expected) < 1e-10;
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

console.log("\n🧮 calculateAverage — unit tests\n");

// 1. Empty array must not crash and must return 0
assert("empty array returns 0", calculateAverage([]), 0);

// 2. Single price is the average of itself
assert("single price [1500] → 1500", calculateAverage([1500]), 1500);

// 3. Two prices
assert("two prices [1000, 2000] → 1500", calculateAverage([1000, 2000]), 1500);

// 4. Three NGN prices (the task's canonical scenario)
assert(
  "three NGN prices [1580, 1600, 1620] → 1600",
  calculateAverage([1580, 1600, 1620]),
  1600,
);

// 5. Floating-point inputs
assert(
  "float prices [1.1, 2.2, 3.3] → 2.2",
  calculateAverage([1.1, 2.2, 3.3]),
  2.2,
);

// 6. All identical prices
assert(
  "identical prices [500, 500, 500] → 500",
  calculateAverage([500, 500, 500]),
  500,
);

// 7. Zero included
assert("prices with zero [0, 300] → 150", calculateAverage([0, 300]), 150);

// 8. Weighted average prefers trusted values over new values
assert(
  "weighted average uses trust tiers",
  calculateWeightedAverage([
    { value: 100, trustLevel: "new" },
    { value: 200, trustLevel: "trusted" },
  ]),
  175,
);

// 9. Explicit weight overrides trust tier
assert(
  "weighted average uses explicit weight override",
  calculateWeightedAverage([
    { value: 100, trustLevel: "trusted", weight: 1 },
    { value: 200, trustLevel: "new", weight: 3 },
  ]),
  175,
);

console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
