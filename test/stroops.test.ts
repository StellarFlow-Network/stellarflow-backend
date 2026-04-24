import { toStroops } from "../src/utils/stroops";

let passed = 0;
let failed = 0;

function assert(description: string, actual: number, expected: number) {
  if (actual === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.log(`  ✗ ${description} — expected ${expected}, got ${actual}`);
    failed++;
  }
}

console.log("🧪 Testing toStroops...\n");

assert("normalize(1.5) returns 15000000", toStroops(1.5), 15_000_000);
assert("normalize(1) returns 10000000", toStroops(1), 10_000_000);
assert("normalize(0) returns 0", toStroops(0), 0);
assert("normalize(0.25) returns 2500000", toStroops(0.25), 2_500_000);
assert('normalize("1.5") returns 15000000', toStroops("1.5"), 15_000_000);
assert('normalize("0.1") returns 1000000', toStroops("0.1"), 1_000_000);
assert(
  "normalize(10000000) integer passthrough",
  toStroops(10_000_000),
  100_000_000_000_000,
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
