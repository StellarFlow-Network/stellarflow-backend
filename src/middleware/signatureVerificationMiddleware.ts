import { Request, Response, NextFunction } from "express";
import nacl from "tweetnacl";

/**
 * Ed25519 Payload Signature Verification Middleware (Issue #225)
 *
 * Verifies the `X-Stellar-Signature` header on every incoming relayer request.
 *
 * Signature scheme:
 *   - The relayer signs the raw JSON request body with its Ed25519 private key.
 *   - The signature is hex-encoded and sent in the `X-Stellar-Signature` header.
 *   - The relayer's Ed25519 public key (hex) must be registered in the database
 *     (`Relayer.publicKey`). Requests from relayers without a registered public
 *     key are rejected when `RELAYER_SIGNATURE_REQUIRED=true`.
 *
 * Environment variables:
 *   RELAYER_SIGNATURE_REQUIRED  - Set to "true" to enforce signature verification
 *                                  (default: false — warn-only mode for rollout)
 */
export const signatureVerificationMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // Only applies to authenticated relayer requests
  if (!req.relayer) {
    next();
    return;
  }

  const enforced = process.env.RELAYER_SIGNATURE_REQUIRED === "true";
  const signatureHeader = req.headers["x-stellar-signature"];

  // ── 1. Header presence check ─────────────────────────────────────────────
  if (!signatureHeader || typeof signatureHeader !== "string") {
    const msg = `[SignatureVerification] Missing X-Stellar-Signature header. Relayer: ${req.relayer.name}`;
    if (enforced) {
      console.warn(msg);
      res.status(401).json({
        success: false,
        error: "Missing X-Stellar-Signature header",
        code: "MISSING_SIGNATURE",
      });
      return;
    }
    console.warn(`${msg} — enforcement disabled, allowing through`);
    next();
    return;
  }

  // ── 2. Public key availability check ─────────────────────────────────────
  const publicKeyHex = req.relayer.publicKey;
  if (!publicKeyHex) {
    const msg = `[SignatureVerification] Relayer "${req.relayer.name}" has no registered public key`;
    if (enforced) {
      console.warn(msg);
      res.status(403).json({
        success: false,
        error: "Relayer has no registered Ed25519 public key",
        code: "NO_PUBLIC_KEY",
      });
      return;
    }
    console.warn(`${msg} — enforcement disabled, allowing through`);
    next();
    return;
  }

  // ── 3. Decode public key ──────────────────────────────────────────────────
  let publicKeyBytes: Uint8Array;
  try {
    publicKeyBytes = hexToBytes(publicKeyHex);
    if (publicKeyBytes.length !== nacl.sign.publicKeyLength) {
      throw new Error(
        `Expected ${nacl.sign.publicKeyLength} bytes, got ${publicKeyBytes.length}`,
      );
    }
  } catch (err) {
    console.error(
      `[SignatureVerification] Invalid public key for relayer "${req.relayer.name}":`,
      err,
    );
    res.status(500).json({
      success: false,
      error: "Relayer public key is malformed",
      code: "INVALID_PUBLIC_KEY",
    });
    return;
  }

  // ── 4. Decode signature ───────────────────────────────────────────────────
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = hexToBytes(signatureHeader);
    if (signatureBytes.length !== nacl.sign.signatureLength) {
      throw new Error(
        `Expected ${nacl.sign.signatureLength} bytes, got ${signatureBytes.length}`,
      );
    }
  } catch (err) {
    console.warn(
      `[SignatureVerification] Malformed signature from relayer "${req.relayer.name}":`,
      err,
    );
    res.status(400).json({
      success: false,
      error: "X-Stellar-Signature header is malformed (expected 128-char hex)",
      code: "MALFORMED_SIGNATURE",
    });
    return;
  }

  // ── 5. Build the message that was signed ─────────────────────────────────
  // The relayer signs the raw JSON body bytes.
  const rawBody = getRawBody(req);
  if (rawBody === null) {
    console.error(
      `[SignatureVerification] Could not read raw body for relayer "${req.relayer.name}"`,
    );
    res.status(400).json({
      success: false,
      error: "Unable to read request body for signature verification",
      code: "BODY_READ_ERROR",
    });
    return;
  }

  const messageBytes = Buffer.from(rawBody, "utf-8");

  // ── 6. Verify the Ed25519 signature ──────────────────────────────────────
  const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);

  if (!valid) {
    console.warn(
      `[SignatureVerification] INVALID signature from relayer "${req.relayer.name}" on ${req.method} ${req.path}`,
    );
    res.status(401).json({
      success: false,
      error: "X-Stellar-Signature verification failed",
      code: "INVALID_SIGNATURE",
    });
    return;
  }

  console.debug(
    `[SignatureVerification] Valid signature from relayer "${req.relayer.name}"`,
  );
  next();
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a hex string to a Uint8Array.
 * Throws if the string is not valid hex.
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("Hex string has odd length");
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("Non-hex characters in string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Retrieve the raw request body as a string.
 *
 * Express parses `req.body` from the raw bytes. We reconstruct the canonical
 * JSON string by re-serialising `req.body` so the signature message is
 * deterministic regardless of whitespace in the original payload.
 *
 * If `req.body` is empty or not an object, returns an empty string.
 */
function getRawBody(req: Request): string | null {
  try {
    if (req.body === undefined || req.body === null) {
      return "";
    }
    // Re-serialise to canonical JSON (no extra whitespace)
    return JSON.stringify(req.body);
  } catch {
    return null;
  }
}
