/**
 * sorobanError.ts
 * ===============
 * Soroban transaction error-code parsing and diagnostic builder.
 *
 * Three layers of errors are handled:
 *
 * 1. Horizon transaction result codes — string tokens in
 *    `error.response.data.extras.result_codes` (e.g. "tx_failed").
 *
 * 2. Soroban RPC codes — numeric codes embedded in the hex-encoded
 *    `errorResultXdr` / `resultMetaXdr` fields returned by the RPC when a
 *    transaction is rejected or a smart-contract invocation reverts.
 *    The raw hex is decoded to a 32-bit big-endian integer to extract the code.
 *
 * 3. Application-level contract error codes — the Soroban `#[contracterror]`
 *    enum variant ordinals defined in `contracts/src/`.  These arrive as the
 *    innermost numeric code inside the XDR envelope.
 *
 * Usage
 * -----
 *   import { parseSorobanError, SorobanTransactionError } from "./sorobanError";
 *
 *   try {
 *     await rpcServer.sendTransaction(tx);
 *   } catch (raw) {
 *     throw parseSorobanError(raw);
 *   }
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Human-readable diagnostic returned in every API error body. */
export interface SorobanDiagnostic {
  /** Symbolic string code consumers should key on, e.g. "SLIPPAGE_EXCEEDED". */
  code: string;
  /** Plain-English description of what went wrong. */
  message: string;
  /**
   * Raw numeric code extracted from the XDR envelope, if available.
   * Useful for debugging and for clients that want to branch on the exact value.
   */
  numericCode: number | null;
  /**
   * Raw hex string from the RPC response, preserved verbatim.
   * Lets callers correlate with chain explorers without needing XDR tooling.
   */
  rawHex: string | null;
  /** ISO-8601 timestamp of when the diagnostic was produced. */
  timestamp: string;
}

/** Custom error class thrown from `parseSorobanError`. Always carries a `diagnostic`. */
export class SorobanTransactionError extends Error {
  readonly code = "SOROBAN_TRANSACTION_ERROR";
  readonly diagnostic: SorobanDiagnostic;

  constructor(diagnostic: SorobanDiagnostic, cause?: unknown) {
    super(diagnostic.message);
    this.name = "SorobanTransactionError";
    this.diagnostic = diagnostic;
    // Preserve the original error as `cause` (Node ≥ 16.9)
    if (cause !== undefined) {
      (this as any).cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Code registries
// ---------------------------------------------------------------------------

/**
 * Soroban RPC invocation sub-error codes.
 *
 * These map to the `InvokeHostFunctionResult` / `InvokeHostFunctionStatus`
 * XDR enum values used in the Soroban RPC protocol.  The value is the
 * low-order byte of the 32-bit code seen in the hex envelope.
 *
 * Reference:
 *   https://github.com/stellar/rs-soroban-env/blob/main/soroban-env-host/src/error.rs
 */
export const SOROBAN_RPC_CODES: Record<number, string> = {
  0: "SUCCESS",
  1: "WASM_VM_ERROR",            // Generic WASM trap / VM panic
  2: "INVOKE_FUNCTION_FAILED",   // Top-level invocation failure
  3: "CONTRACT_ERROR",           // Contract panicked via sdk::panic_with_error
  4: "STORAGE_ERROR",            // Ledger key not found or footprint violation
  5: "RESOURCE_LIMIT_EXCEEDED",  // Instruction / memory / entry budget exceeded
  6: "VALUE_ERROR",              // Malformed ScVal
  7: "AUTH_ERROR",               // Missing or invalid authorization
  8: "CYCLE_ERROR",              // Reentrancy or circular contract call
  9: "INTERNAL_ERROR",           // Soroban host internal error
};

/**
 * Application-level contract error codes.
 *
 * These are the `#[contracterror]` enum ordinals emitted by the StellarFlow
 * smart contracts (see `contracts/src/models.rs` and related files).
 */
export const CONTRACT_ERROR_CODES: Record<number, string> = {
  // Core oracle errors (1–9)
  1: "UNAUTHORIZED",            // Caller is not an authorized relayer/admin
  2: "INVALID_PRICE",           // Submitted price is zero or negative
  3: "SLIPPAGE_EXCEEDED",       // Price moved beyond the allowed slippage band
  4: "PRICE_TOO_STALE",         // Data timestamp is older than the freshness window
  5: "PRICE_TOO_NEW",           // Data timestamp is in the future
  6: "DUPLICATE_SUBMISSION",    // Identical payload already recorded on-chain
  7: "OVERFLOW",                // Arithmetic overflow in price calculation

  // Ledger / submission gate errors (10–19)
  10: "GAP_TOO_SMALL",          // MIN_BLOCK_GAP not satisfied (models.rs)
  11: "SEQUENCE_MISMATCH",      // Relayer sequence out of sync
  12: "LEDGER_CLOSED",          // Target ledger is already closed

  // Governance contract errors (20–29)
  20: "PROPOSAL_NOT_FOUND",
  21: "PROPOSAL_EXPIRED",
  22: "ALREADY_VOTED",
  23: "VOTING_CLOSED",
  24: "QUORUM_NOT_MET",
  25: "TIMELOCK_ACTIVE",        // Proposal still within mandatory timelock period

  // Storage / rent errors (30–39)
  30: "STORAGE_ENTRY_NOT_FOUND",
  31: "RENT_LEDGER_THRESHOLD",  // TTL has dropped below the bump threshold
  32: "FOOTPRINT_VIOLATION",    // Key accessed but not declared in footprint

  // Auth errors (40–49)
  40: "AUTH_REVOKED",           // Signer's on-chain authorization has been revoked
  41: "SIGNATURE_INVALID",
  42: "INSUFFICIENT_WEIGHT",    // Multi-sig threshold not reached

  // Fallback
  255: "UNKNOWN_CONTRACT_ERROR",
};

/** Human-readable messages for every symbolic code in CONTRACT_ERROR_CODES. */
const CONTRACT_ERROR_MESSAGES: Record<string, string> = {
  UNAUTHORIZED:              "Caller is not authorized to submit to this contract.",
  INVALID_PRICE:             "The submitted price is invalid (zero or negative).",
  SLIPPAGE_EXCEEDED:         "Price deviation exceeds the permitted slippage tolerance.",
  PRICE_TOO_STALE:           "The submitted price timestamp is outside the freshness window.",
  PRICE_TOO_NEW:             "The submitted price timestamp is ahead of the current ledger time.",
  DUPLICATE_SUBMISSION:      "An identical price payload has already been recorded on-chain.",
  OVERFLOW:                  "Arithmetic overflow occurred while processing the price calculation.",
  GAP_TOO_SMALL:             "Insufficient ledger gap since the last submission; wait for more ledgers.",
  SEQUENCE_MISMATCH:         "Relayer sequence number does not match the contract state.",
  LEDGER_CLOSED:             "The target ledger has already closed; resubmit with a fresh sequence.",
  PROPOSAL_NOT_FOUND:        "The referenced governance proposal does not exist.",
  PROPOSAL_EXPIRED:          "The governance proposal has passed its deadline.",
  ALREADY_VOTED:             "This account has already cast a vote on this proposal.",
  VOTING_CLOSED:             "The voting period for this proposal has ended.",
  QUORUM_NOT_MET:            "The proposal did not reach the required quorum to execute.",
  TIMELOCK_ACTIVE:           "The proposal is still within its mandatory timelock period.",
  STORAGE_ENTRY_NOT_FOUND:   "The requested ledger storage entry was not found.",
  RENT_LEDGER_THRESHOLD:     "Storage TTL is below the bump threshold; the entry may be evicted.",
  FOOTPRINT_VIOLATION:       "Transaction accessed a key not declared in its read/write footprint.",
  AUTH_REVOKED:              "The signer's on-chain authorization has been revoked.",
  SIGNATURE_INVALID:         "One or more transaction signatures failed verification.",
  INSUFFICIENT_WEIGHT:       "Collected signature weight does not meet the multi-sig threshold.",
  UNKNOWN_CONTRACT_ERROR:    "An unrecognized contract error code was returned.",
};

/**
 * Horizon-level transaction result codes.
 * Returned as strings in `error.response.data.extras.result_codes`.
 */
export const HORIZON_TX_RESULT_CODES: Record<string, string> = {
  tx_success:                    "Transaction succeeded.",
  tx_failed:                     "One or more operations in the transaction failed.",
  tx_too_early:                  "Transaction ledger sequence is before the current network time.",
  tx_too_late:                   "Transaction ledger sequence is past the current network time.",
  tx_missing_operation:          "No operations were specified in the transaction.",
  tx_bad_seq:                    "Transaction sequence number does not match the source account.",
  tx_bad_auth:                   "Insufficient or incorrect authorization provided.",
  tx_insufficient_balance:       "Source account balance is too low to cover the transaction fee.",
  tx_no_source_account:          "Source account does not exist on the ledger.",
  tx_insufficient_fee:           "Transaction fee is too low to be accepted by the network.",
  tx_bad_auth_extra:             "The transaction contains more signatures than required.",
  tx_internal_error:             "An internal Stellar network error occurred.",
  tx_not_supported:              "The transaction type is not supported on this network.",
  tx_bad_sponsorship:            "The transaction has an invalid sponsorship structure.",
  tx_bad_minseq_age_or_gap:      "Transaction minSeqAge or minSeqLedgerGap constraint not satisfied.",
  tx_malformed:                  "The transaction envelope is malformed.",
};

// ---------------------------------------------------------------------------
// Hex parsing
// ---------------------------------------------------------------------------

/**
 * Attempt to extract numeric error codes from a raw hex string.
 *
 * Soroban RPC returns error result XDR as a hex-encoded big-endian buffer.
 * The first 4 bytes encode a top-level status word; the last 4 bytes of
 * certain payloads carry the application-level contract error ordinal.
 *
 * @param hex  Raw hex string — optional 0x prefix, any casing, whitespace OK.
 * @returns    `topCode` (first 4 bytes) and `innerCode` (last 4 bytes, or null).
 * @throws     `TypeError`  for non-string input or invalid hex characters.
 * @throws     `RangeError` for strings too short to hold 4 bytes.
 */
export function decodeHexErrorCode(hex: string): {
  topCode: number;
  innerCode: number | null;
} {
  if (typeof hex !== "string") {
    throw new TypeError(`Expected string, received ${typeof hex}`);
  }

  let clean = hex.trim();
  if (clean.startsWith("0x") || clean.startsWith("0X")) {
    clean = clean.slice(2);
  }
  clean = clean.toUpperCase();

  if (clean.length < 8) {
    throw new RangeError(
      `Hex string is too short (${clean.length} chars); need at least 8 (4 bytes).`,
    );
  }

  if (!/^[0-9A-F]+$/.test(clean)) {
    throw new TypeError(`Hex string contains invalid characters: "${clean}"`);
  }

  const buf = Buffer.from(clean, "hex");
  const topCode = buf.readUInt32BE(0);
  const innerCode = buf.length >= 8 ? buf.readUInt32BE(buf.length - 4) : null;

  return { topCode, innerCode };
}

// ---------------------------------------------------------------------------
// Code → symbolic name resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a numeric code to its symbolic name and human-readable message.
 *
 * Precedence: CONTRACT_ERROR_CODES > SOROBAN_RPC_CODES > fallback.
 */
function resolveNumericCode(code: number): { symbolic: string; message: string } {
  if (code in CONTRACT_ERROR_CODES) {
    const symbolic = CONTRACT_ERROR_CODES[code]!;
    return {
      symbolic,
      message:
        CONTRACT_ERROR_MESSAGES[symbolic] ??
        `Contract error code ${code}.`,
    };
  }

  if (code in SOROBAN_RPC_CODES) {
    const name = SOROBAN_RPC_CODES[code]!;
    return {
      symbolic: `SOROBAN_${name}`,
      message: `Soroban RPC error: ${name.toLowerCase().replace(/_/g, " ")}.`,
    };
  }

  return {
    symbolic: "SOROBAN_UNKNOWN_CODE",
    message: `Unrecognized Soroban error code: ${code}.`,
  };
}

// ---------------------------------------------------------------------------
// Raw error inspection helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract a hex error string from any shape of error the Soroban RPC
 * SDK may produce.
 *
 * Inspected locations:
 *   - `error.errorResultXdr`          (SorobanRpc.SendTransactionResponse FAILED)
 *   - `error.resultMetaXdr`
 *   - `error.resultXdr` / `result_xdr`
 *   - `error.extras.result_xdr`
 *   - `error.response.data.extras.result_xdr`
 */
function extractHexFromError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const err = error as Record<string, any>;

  for (const field of ["errorResultXdr", "resultMetaXdr", "resultXdr", "result_xdr"]) {
    const val = err[field];
    if (typeof val === "string" && val.length > 0) return val;
  }

  const extras = err.extras ?? err.response?.data?.extras;
  if (extras && typeof extras === "object") {
    for (const field of ["result_xdr", "envelope_xdr"]) {
      const val = (extras as Record<string, any>)[field];
      if (typeof val === "string" && val.length > 0) return val;
    }
  }

  return null;
}

/** Extract the Horizon string result code from an error object, if present. */
function extractHorizonResultCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const err = error as Record<string, any>;

  const rc = err.response?.data?.extras?.result_codes;
  if (!rc) return null;

  if (typeof rc.transaction === "string") return rc.transaction;
  if (Array.isArray(rc.operations) && typeof rc.operations[0] === "string") {
    return rc.operations[0] as string;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diagnostic builder
// ---------------------------------------------------------------------------

/**
 * Build a fully-populated `SorobanDiagnostic` from any error thrown during a
 * Soroban transaction flow.
 *
 * Resolution order:
 *   1. Soroban hex payload — prefer the inner (contract-level) code over the
 *      outer (RPC-level) code when both are present and non-zero.
 *   2. Horizon string result code.
 *   3. Raw `error.message`.
 *   4. Generic unknown fallback.
 */
export function buildSorobanDiagnostic(error: unknown): SorobanDiagnostic {
  const timestamp = new Date().toISOString();
  const rawHex = extractHexFromError(error);

  // ── Strategy 1: decode the hex XDR payload ─────────────────────────────
  if (rawHex !== null) {
    try {
      const { topCode, innerCode } = decodeHexErrorCode(rawHex);

      // Prefer the innermost code — it carries the application-level contract error.
      // Skip if innerCode is 0 or identical to topCode (means no inner payload).
      const preferredCode =
        innerCode !== null && innerCode !== 0 && innerCode !== topCode
          ? innerCode
          : topCode;

      const { symbolic, message } = resolveNumericCode(preferredCode);

      return {
        code: symbolic,
        message,
        numericCode: preferredCode,
        rawHex,
        timestamp,
      };
    } catch {
      // Hex was malformed; fall through to other strategies.
    }
  }

  // ── Strategy 2: Horizon string result code ──────────────────────────────
  const horizonCode = extractHorizonResultCode(error);
  if (horizonCode !== null) {
    const message =
      HORIZON_TX_RESULT_CODES[horizonCode] ??
      `Horizon rejected the transaction with code "${horizonCode}".`;
    return {
      code: `HORIZON_${horizonCode.toUpperCase()}`,
      message,
      numericCode: null,
      rawHex,
      timestamp,
    };
  }

  // ── Strategy 3: raw error message ───────────────────────────────────────
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "An unspecified Soroban error occurred.";

  return {
    code: "SOROBAN_UNKNOWN_ERROR",
    message: rawMessage,
    numericCode: null,
    rawHex,
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Primary entry point
// ---------------------------------------------------------------------------

/**
 * Parse any raw error thrown during a Soroban transaction flow into a
 * `SorobanTransactionError` with a fully-populated diagnostic.
 *
 * If the error is already a `SorobanTransactionError`, it is returned unchanged.
 *
 * @example
 * ```typescript
 * try {
 *   await stellarService.submitPriceUpdate(currency, price, memoId);
 * } catch (raw) {
 *   throw parseSorobanError(raw);
 * }
 * ```
 */
export function parseSorobanError(raw: unknown): SorobanTransactionError {
  if (raw instanceof SorobanTransactionError) return raw;
  const diagnostic = buildSorobanDiagnostic(raw);
  return new SorobanTransactionError(diagnostic, raw);
}

/**
 * Type guard — true when `error` is a `SorobanTransactionError`.
 */
export function isSorobanTransactionError(
  error: unknown,
): error is SorobanTransactionError {
  return error instanceof SorobanTransactionError;
}
