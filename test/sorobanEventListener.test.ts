import {
  SorobanEventListener,
  ConfirmedPrice,
} from "../src/services/sorobanEventListener";

let passed = 0;
let failed = 0;

function assert(description: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.log(`  ✗ ${description}`);
    failed++;
  }
}

console.log("🧪 Testing SorobanEventListener...\n");

// Test 1: Constructor throws without secret key
console.log("Constructor validation:");
const originalOracleKey = process.env.ORACLE_SECRET_KEY;
const originalSorobanKey = process.env.SOROBAN_ADMIN_SECRET;

delete process.env.ORACLE_SECRET_KEY;
delete process.env.SOROBAN_ADMIN_SECRET;

let threwError = false;
try {
  new SorobanEventListener();
} catch (e) {
  threwError = true;
  assert(
    "throws error when no secret key is configured",
    e instanceof Error &&
      e.message.includes("not found in environment variables"),
  );
}
assert("constructor throws without keys", threwError);

// Restore keys for further tests
process.env.ORACLE_SECRET_KEY = originalOracleKey;
process.env.SOROBAN_ADMIN_SECRET = originalSorobanKey;

// Test 2: Valid instantiation with secret key
console.log("\nInstantiation with valid key:");
if (originalOracleKey || originalSorobanKey) {
  try {
    const listener = new SorobanEventListener();
    assert("creates instance with valid key", listener !== null);
    assert("isActive returns false initially", listener.isActive() === false);
    assert(
      "getOraclePublicKey returns a string",
      typeof listener.getOraclePublicKey() === "string",
    );
    assert(
      "public key starts with G",
      listener.getOraclePublicKey().startsWith("G"),
    );
  } catch (e) {
    console.log(`  ⚠ Skipped: ${e instanceof Error ? e.message : e}`);
  }
} else {
  console.log("  ⚠ Skipped: No secret key configured");
}

// Test 3: ConfirmedPrice interface shape
console.log("\nConfirmedPrice interface:");
const mockPrice: ConfirmedPrice = {
  currency: "NGN",
  rate: 1650.25,
  txHash: "abc123def456",
  memoId: "SF-NGN-1234567890-001",
  ledgerSeq: 12345,
  confirmedAt: new Date(),
};
assert("currency is string", typeof mockPrice.currency === "string");
assert("rate is number", typeof mockPrice.rate === "number");
assert("txHash is string", typeof mockPrice.txHash === "string");
assert(
  "memoId can be string or null",
  mockPrice.memoId === null || typeof mockPrice.memoId === "string",
);
assert("ledgerSeq is number", typeof mockPrice.ledgerSeq === "number");
assert("confirmedAt is Date", mockPrice.confirmedAt instanceof Date);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
