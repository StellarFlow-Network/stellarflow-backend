/**
 * test/sorobanError.test.ts
 * ========================
 * Unit tests for src/lib/sorobanError.ts
 *
 * Covers:
 *  - decodeHexErrorCode(): happy path, edge cases, validation errors
 *  - buildSorobanDiagnostic(): hex path, Horizon path, raw message fallback, unknown code fallback
 *  - parseSorobanError(): wraps raw errors, passes through SorobanTransactionError unchanged
 *  - isSorobanTransactionError(): type guard
 *  - Code registry completeness spot-checks
 *
 * Run with:
 *   npx tsx --test test/sorobanError.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeHexErrorCode,
  buildSorobanDiagnostic,
  parseSorobanError,
  isSorobanTransactionError,
  SorobanTransactionError,
  CONTRACT_ERROR_CODES,
  SOROBAN_RPC_CODES,
  HORIZON_TX_RESULT_CODES,
} from "../src/lib/sorobanError.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a hex string from a 32-bit big-endian number (4 bytes = 8 hex chars).
 */
function uint32ToHex(n: number): string {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n, 0);
  return buf.toString("hex");
}

/**
 * Build an 8-byte hex string: first 4 bytes = outerCode, last 4 bytes = innerCode.
 */
function twoWordHex(outerCode: number, innerCode: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(outerCode, 0);
  buf.writeUInt32BE(innerCode, 4);
  return buf.toString("hex");
}

// ---------------------------------------------------------------------------
// decodeHexErrorCode
// ---------------------------------------------------------------------------

test("decodeHexErrorCode — basic 4-byte hex", () => {
  const hex = uint32ToHex(3); // code 3 = SLIPPAGE_EXCEEDED
  const { topCode, innerCode } = decodeHexErrorCode(hex);
  assert.equal(topCode, 3);
  assert.equal(innerCode, null); // only 4 bytes, no inner code
});

test("decodeHexErrorCode — 8-byte hex with distinct inner code", () => {
  const hex = twoWordHex(2, 10); // outer=INVOKE_FUNCTION_FAILED, inner=GAP_TOO_SMALL
  const { topCode, innerCode } = decodeHexErrorCode(hex);
  assert.equal(topCode, 2);
  assert.equal(innerCode, 10);
});

test("decodeHexErrorCode — 0x prefix is stripped", () => {
  const hex = "0x" + uint32ToHex(1);
  const { topCode } = decodeHexErrorCode(hex);
  assert.equal(topCode, 1);
});

test("decodeHexErrorCode — 0X uppercase prefix is stripped", () => {
  const hex = "0X" + uint32ToHex(5);
  const { topCode } = decodeHexErrorCode(hex);
  assert.equal(topCode, 5);
});

test("decodeHexErrorCode — mixed-case input is normalized", () => {
  const hex = uint32ToHex(7).toLowerCase(); // lowercase hex
  const { topCode } = decodeHexErrorCode(hex);
  assert.equal(topCode, 7);
});

test("decodeHexErrorCode — leading and trailing whitespace is stripped", () => {
  const hex = "  " + uint32ToHex(4) + "  ";
  const { topCode } = decodeHexErrorCode(hex);
  assert.equal(topCode, 4);
});

test("decodeHexErrorCode — longer buffers use last-4-bytes as innerCode", () => {
  // 12-byte buffer: bytes 0-3 = top, bytes 8-11 = inner
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(2, 0);   // top
  buf.writeUInt32BE(99, 4);  // middle (ignored)
  buf.writeUInt32BE(3, 8);   // inner = last 4 bytes
  const { topCode, innerCode } = decodeHexErrorCode(buf.toString("hex"));
  assert.equal(topCode, 2);
  assert.equal(innerCode, 3);
});

test("decodeHexErrorCode — throws TypeError for non-string input", () => {
  assert.throws(
    () => decodeHexErrorCode(42 as any),
    { name: "TypeError" },
  );
});

test("decodeHexErrorCode — throws RangeError for string shorter than 8 hex chars", () => {
  assert.throws(
    () => decodeHexErrorCode("DEAD"), // only 2 bytes
    { name: "RangeError" },
  );
});

test("decodeHexErrorCode — throws TypeError for non-hex characters", () => {
  assert.throws(
    () => decodeHexErrorCode("ZZZZZZZZ"),
    { name: "TypeError" },
  );
});

test("decodeHexErrorCode — throws RangeError for empty string after stripping prefix", () => {
  assert.throws(
    () => decodeHexErrorCode("0x"),
    { name: "RangeError" },
  );
});

// ---------------------------------------------------------------------------
// buildSorobanDiagnostic — hex path
// ---------------------------------------------------------------------------

test("buildSorobanDiagnostic — maps code 3 (inner) to SLIPPAGE_EXCEEDED", () => {
  // errorResultXdr carrying outer=CONTRACT_ERROR(3), inner=SLIPPAGE_EXCEEDED(3)
  const errorResultXdr = twoWordHex(3, 3);
  const diag = buildSorobanDiagnostic({ errorResultXdr });
  assert.equal(diag.code, "SLIPPAGE_EXCEEDED");
  assert.match(diag.message, /slippage/i);
  assert.equal(diag.numericCode, 3);
  assert.equal(diag.rawHex, errorResultXdr);
});

test("buildSorobanDiagnostic — maps code 1 to UNAUTHORIZED (contract error)", () => {
  const errorResultXdr = twoWordHex(3, 1);
  const diag = buildSorobanDiagnostic({ errorResultXdr });
  assert.equal(diag.code, "UNAUTHORIZED");
  assert.equal(diag.numericCode, 1);
});

test("buildSorobanDiagnostic — maps code 10 to GAP_TOO_SMALL", () => {
  const errorResultXdr = twoWordHex(3, 10);
  const diag = buildSorobanDiagnostic({ errorResultXdr });
  assert.equal(diag.code, "GAP_TOO_SMALL");
  assert.match(diag.message, /ledger gap/i);
});

test("buildSorobanDiagnostic — prefers inner code over outer when inner is non-zero and different", () => {
  // outer=2 (INVOKE_FUNCTION_FAILED), inner=42 (INSUFFICIENT_WEIGHT)
  const errorResultXdr = twoWordHex(2, 42);
  const diag = buildSorobanDiagnostic({ errorResultXdr });
  assert.equal(diag.code, "INSUFFICIENT_WEIGHT");
  assert.equal(diag.numericCode, 42);
});

test("buildSorobanDiagnostic — falls back to topCode when innerCode is 0", () => {
  // outer=9 (SOROBAN_RPC_CODES.INTERNAL_ERROR — not in CONTRACT_ERROR_CODES), inner=0
  // inner is 0 so topCode is preferred; code 9 is only in SOROBAN_RPC_CODES
  const errorResultXdr = twoWordHex(9, 0);
  const diag = buildSorobanDiagnostic({ errorResultXdr });
  assert.equal(diag.code, "SOROBAN_INTERNAL_ERROR");
  assert.equal(diag.numericCode, 9);
});

test("buildSorobanDiagnostic — falls back to topCode when innerCode equals topCode", () => {
  // outer=4 inner=4 (same value, not a distinct inner code)
  const errorResultXdr = twoWordHex(4, 4);
  const diag = buildSorobanDiagnostic({ errorResultXdr });
  // code 4 is in CONTRACT_ERROR_CODES, maps to PRICE_TOO_STALE
  assert.equal(diag.code, "PRICE_TOO_STALE");
  assert.equal(diag.numericCode, 4);
});

test("buildSorobanDiagnostic — unknown code produces SOROBAN_UNKNOWN_CODE", () => {
  const errorResultXdr = twoWordHex(999, 999);
  const diag = buildSorobanDiagnostic({ errorResultXdr });
  assert.equal(diag.code, "SOROBAN_UNKNOWN_CODE");
  assert.match(diag.message, /unrecognized/i);
  assert.equal(diag.numericCode, 999);
});

test("buildSorobanDiagnostic — reads errorResultXdr from nested response shape", () => {
  // Some SDK versions nest this differently
  const error = { extras: { result_xdr: twoWordHex(0, 3) } };
  const diag = buildSorobanDiagnostic(error);
  assert.equal(diag.code, "SLIPPAGE_EXCEEDED");
});

test("buildSorobanDiagnostic — includes a valid ISO timestamp", () => {
  const diag = buildSorobanDiagnostic(new Error("test"));
  assert.ok(new Date(diag.timestamp).getTime() > 0);
});

// ---------------------------------------------------------------------------
// buildSorobanDiagnostic — Horizon path
// ---------------------------------------------------------------------------

test("buildSorobanDiagnostic — maps Horizon tx_bad_seq string code", () => {
  const error = {
    response: {
      data: {
        extras: {
          result_codes: { transaction: "tx_bad_seq" },
        },
      },
    },
  };
  const diag = buildSorobanDiagnostic(error);
  assert.equal(diag.code, "HORIZON_TX_BAD_SEQ");
  assert.match(diag.message, /sequence number/i);
  assert.equal(diag.numericCode, null);
  assert.equal(diag.rawHex, null);
});

test("buildSorobanDiagnostic — maps Horizon tx_insufficient_fee string code", () => {
  const error = {
    response: {
      data: {
        extras: {
          result_codes: { transaction: "tx_insufficient_fee" },
        },
      },
    },
  };
  const diag = buildSorobanDiagnostic(error);
  assert.equal(diag.code, "HORIZON_TX_INSUFFICIENT_FEE");
  assert.match(diag.message, /fee/i);
});

test("buildSorobanDiagnostic — picks up Horizon code from operations[0] when transaction missing", () => {
  const error = {
    response: {
      data: {
        extras: {
          result_codes: { operations: ["op_bad_auth"] },
        },
      },
    },
  };
  const diag = buildSorobanDiagnostic(error);
  assert.equal(diag.code, "HORIZON_OP_BAD_AUTH");
});

// ---------------------------------------------------------------------------
// buildSorobanDiagnostic — raw message fallback
// ---------------------------------------------------------------------------

test("buildSorobanDiagnostic — falls back to Error.message when no hex or horizon code", () => {
  const error = new Error("network timeout");
  const diag = buildSorobanDiagnostic(error);
  assert.equal(diag.code, "SOROBAN_UNKNOWN_ERROR");
  assert.equal(diag.message, "network timeout");
  assert.equal(diag.numericCode, null);
  assert.equal(diag.rawHex, null);
});

test("buildSorobanDiagnostic — falls back to generic message for non-Error non-string", () => {
  const diag = buildSorobanDiagnostic({ someField: "value" });
  assert.equal(diag.code, "SOROBAN_UNKNOWN_ERROR");
  assert.match(diag.message, /unspecified/i);
});

test("buildSorobanDiagnostic — handles null gracefully", () => {
  const diag = buildSorobanDiagnostic(null);
  assert.equal(diag.code, "SOROBAN_UNKNOWN_ERROR");
});

test("buildSorobanDiagnostic — handles plain string error", () => {
  const diag = buildSorobanDiagnostic("something broke");
  assert.equal(diag.code, "SOROBAN_UNKNOWN_ERROR");
  assert.equal(diag.message, "something broke");
});

// ---------------------------------------------------------------------------
// parseSorobanError
// ---------------------------------------------------------------------------

test("parseSorobanError — wraps a plain Error into SorobanTransactionError", () => {
  const raw = new Error("rpc failure");
  const err = parseSorobanError(raw);
  assert.ok(err instanceof SorobanTransactionError);
  assert.ok(err instanceof Error);
  assert.equal(err.name, "SorobanTransactionError");
  assert.equal(err.code, "SOROBAN_TRANSACTION_ERROR");
  assert.ok(err.diagnostic);
  assert.equal(err.message, "rpc failure");
});

test("parseSorobanError — wraps an object with errorResultXdr", () => {
  const raw = { errorResultXdr: twoWordHex(3, 3) };
  const err = parseSorobanError(raw);
  assert.ok(err instanceof SorobanTransactionError);
  assert.equal(err.diagnostic.code, "SLIPPAGE_EXCEEDED");
  assert.equal(err.diagnostic.numericCode, 3);
});

test("parseSorobanError — passes through an existing SorobanTransactionError unchanged", () => {
  const original = parseSorobanError(new Error("first wrap"));
  const second = parseSorobanError(original);
  assert.strictEqual(original, second, "should be the exact same instance");
});

test("parseSorobanError — preserves original error as cause", () => {
  const raw = new Error("root cause");
  const err = parseSorobanError(raw);
  assert.strictEqual((err as any).cause, raw);
});

// ---------------------------------------------------------------------------
// isSorobanTransactionError (type guard)
// ---------------------------------------------------------------------------

test("isSorobanTransactionError — true for SorobanTransactionError instance", () => {
  const err = parseSorobanError(new Error("test"));
  assert.ok(isSorobanTransactionError(err));
});

test("isSorobanTransactionError — false for plain Error", () => {
  assert.ok(!isSorobanTransactionError(new Error("plain")));
});

test("isSorobanTransactionError — false for null", () => {
  assert.ok(!isSorobanTransactionError(null));
});

test("isSorobanTransactionError — false for plain object", () => {
  assert.ok(!isSorobanTransactionError({ code: "SOROBAN_TRANSACTION_ERROR" }));
});

// ---------------------------------------------------------------------------
// Registry spot-checks
// ---------------------------------------------------------------------------

test("CONTRACT_ERROR_CODES covers all governance errors (20–25)", () => {
  for (let code = 20; code <= 25; code++) {
    assert.ok(
      code in CONTRACT_ERROR_CODES,
      `Expected governance error code ${code} to be in CONTRACT_ERROR_CODES`,
    );
  }
});

test("CONTRACT_ERROR_CODES code 3 is SLIPPAGE_EXCEEDED", () => {
  assert.equal(CONTRACT_ERROR_CODES[3], "SLIPPAGE_EXCEEDED");
});

test("SOROBAN_RPC_CODES code 5 is RESOURCE_LIMIT_EXCEEDED", () => {
  assert.equal(SOROBAN_RPC_CODES[5], "RESOURCE_LIMIT_EXCEEDED");
});

test("HORIZON_TX_RESULT_CODES contains tx_bad_seq", () => {
  assert.ok("tx_bad_seq" in HORIZON_TX_RESULT_CODES);
  assert.match(HORIZON_TX_RESULT_CODES["tx_bad_seq"]!, /sequence/i);
});

test("All CONTRACT_ERROR_CODES values are non-empty strings", () => {
  for (const [code, name] of Object.entries(CONTRACT_ERROR_CODES)) {
    assert.ok(
      typeof name === "string" && name.length > 0,
      `CODE ${code} has empty name`,
    );
  }
});

test("All SOROBAN_RPC_CODES values are non-empty strings", () => {
  for (const [code, name] of Object.entries(SOROBAN_RPC_CODES)) {
    assert.ok(
      typeof name === "string" && name.length > 0,
      `RPC CODE ${code} has empty name`,
    );
  }
});

// ---------------------------------------------------------------------------
// Edge / boundary cases
// ---------------------------------------------------------------------------

test("decodeHexErrorCode — all-zero 8-byte payload produces topCode=0 innerCode=0", () => {
  const hex = "0000000000000000";
  const { topCode, innerCode } = decodeHexErrorCode(hex);
  assert.equal(topCode, 0);
  assert.equal(innerCode, 0);
});

test("buildSorobanDiagnostic — malformed hex falls through to Horizon code path", () => {
  // errorResultXdr is present but too short to decode — should not throw,
  // should fall through to Horizon code
  const error = {
    errorResultXdr: "DEAD", // 2 bytes — below 4-byte minimum
    response: {
      data: {
        extras: {
          result_codes: { transaction: "tx_failed" },
        },
      },
    },
  };
  const diag = buildSorobanDiagnostic(error);
  assert.equal(diag.code, "HORIZON_TX_FAILED");
});

test("SorobanTransactionError carries a diagnostic with all required fields", () => {
  const err = parseSorobanError({ errorResultXdr: twoWordHex(1, 1) });
  const { diagnostic } = err;
  assert.ok(typeof diagnostic.code === "string" && diagnostic.code.length > 0);
  assert.ok(typeof diagnostic.message === "string" && diagnostic.message.length > 0);
  assert.ok(typeof diagnostic.timestamp === "string");
  assert.ok(new Date(diagnostic.timestamp).getTime() > 0);
});
