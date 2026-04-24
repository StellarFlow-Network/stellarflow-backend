import { Keypair } from "@stellar/stellar-sdk";
import { logger } from "../utils/logger";

export type ReloadTrigger = "admin-endpoint" | "file-watcher" | "startup";

// Module-level private state (singleton pattern matching appState.ts)
let activeKey: string;
let reloadCount: number = 0;

/**
 * Validates a candidate Stellar secret key.
 * Throws with a safe message — never includes the candidate value.
 */
function validateKey(candidate: string): void {
  if (!candidate || candidate.trim().length === 0) {
    throw new Error("Secret key must not be empty");
  }

  try {
    Keypair.fromSecret(candidate);
  } catch {
    throw new Error("Invalid Stellar secret key format");
  }
}

// Initialize from environment at module load time
const initialKey =
  process.env.ORACLE_SECRET_KEY || process.env.SOROBAN_ADMIN_SECRET;

if (!initialKey) {
  throw new Error("Stellar secret key not found in environment variables");
}

// Validate the initial key before storing
validateKey(initialKey);
activeKey = initialKey;

/**
 * Returns the currently active Stellar secret key.
 */
export function getSecretKey(): string {
  return activeKey;
}

/**
 * Returns the public key derived from the currently active secret key.
 * Safe to log — never exposes the secret.
 */
export function getPublicKey(): string {
  return Keypair.fromSecret(activeKey).publicKey();
}

/**
 * Returns the number of successful key updates since module load.
 */
export function getReloadCount(): number {
  return reloadCount;
}

/**
 * Validates and atomically replaces the in-memory secret key.
 * Increments reloadCount and emits an INFO log on success.
 * Emits a WARN log on failure — never logs the candidate key value.
 */
export function updateSecretKey(
  newKey: string,
  trigger: ReloadTrigger = "admin-endpoint",
): void {
  try {
    validateKey(newKey);

    // Derive public key before replacing (for logging)
    const newPublicKey = Keypair.fromSecret(newKey).publicKey();

    // Atomic reference replacement — any concurrent getSecretKey() call
    // returns either the old or new key, never undefined
    activeKey = newKey;
    reloadCount += 1;

    logger.info("[SecretManager] Key reloaded successfully.", "SecretManager", {
      trigger,
      publicKey: newPublicKey,
      reloadCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    logger.warn("[SecretManager] Key reload rejected.", "SecretManager", {
      trigger,
      reason: err.message,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}
