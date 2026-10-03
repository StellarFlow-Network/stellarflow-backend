import { createHash, createPublicKey, verify } from "node:crypto";
import { xdr } from "@stellar/stellar-sdk";

export interface SorobanInvokerEnvelope {
  authorizationEntryXdr: string;
  signaturePayload: string;
  publicKey: string;
  currentLedger: number;
  validUntilLedger: number;
  accountBalanceStroops: number;
  requiredBalanceStroops: number;
}

export type SorobanInvokerValidation =
  | { valid: true; address: string; validUntilLedger: number }
  | { valid: false; reason: string };

/**
 * Validates a Soroban address-credential envelope before it reaches a relayer.
 * The caller must provide the canonical authorization payload produced by the
 * Soroban transaction builder; signing arbitrary request JSON is not accepted.
 */
export function validateSorobanInvoker(
  envelope: SorobanInvokerEnvelope,
): SorobanInvokerValidation {
  if (!Number.isSafeInteger(envelope.currentLedger)) {
    return { valid: false, reason: "current ledger is invalid" };
  }
  if (envelope.validUntilLedger <= envelope.currentLedger) {
    return { valid: false, reason: "authorization credential has expired" };
  }
  if (envelope.accountBalanceStroops < envelope.requiredBalanceStroops) {
    return { valid: false, reason: "account balance is insufficient" };
  }

  let entry: any;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(
      envelope.authorizationEntryXdr,
      "base64",
    );
  } catch {
    return { valid: false, reason: "authorization entry XDR is malformed" };
  }

  const credentials = entry.credentials();
  if (credentials.switch().name !== "sorobanCredentialsAddress") {
    return { valid: false, reason: "authorization entry is not address-based" };
  }

  const address = credentials.address().address().toString();
  const signature = credentials.address().signature().bytes();
  const publicKey = decodeRawKey(envelope.publicKey);
  if (!publicKey || signature.length !== 64) {
    return { valid: false, reason: "invoker key or signature is malformed" };
  }

  const payload = createHash("sha256")
    .update(Buffer.from(envelope.signaturePayload, "base64"))
    .digest();
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      publicKey,
    ]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, payload, key, Buffer.from(signature))) {
    return { valid: false, reason: "invoker signature is invalid" };
  }

  return {
    valid: true,
    address,
    validUntilLedger: envelope.validUntilLedger,
  };
}

function decodeRawKey(value: string): Buffer | null {
  const normalized = value.trim();
  const decoded = /^[0-9a-f]{64}$/i.test(normalized)
    ? Buffer.from(normalized, "hex")
    : Buffer.from(normalized, "base64");
  return decoded.length === 32 ? decoded : null;
}
