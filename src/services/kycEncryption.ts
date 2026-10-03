/**
 * SEP-12 KYC payload encryption.
 *
 * Customer information must never be persisted in plaintext. This service
 * wraps the repository's existing AES-256-GCM helper
 * (`src/crypto/encryption.ts`) so KYC payloads are encrypted at rest with a
 * key supplied through configuration:
 *
 *   KYC_ENCRYPTION_KEY  – preferred, dedicated key for the KYC store
 *   VAULT_MASTER_KEY    – fallback, the key already used for vault secrets
 *
 * No new dependency is introduced: `src/crypto/encryption.ts` is built on the
 * platform `node:crypto` module.
 */

import { decrypt, encrypt } from "../crypto/encryption";
import type { KycPayload } from "./kycTypes";

export class KycEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KycEncryptionError";
  }
}

export class KycEncryptionService {
  constructor(private readonly keyOverride?: string) {}

  /**
   * Resolve the master key lazily so the service works whether the environment
   * is loaded before or after this module is imported.
   */
  private resolveKey(): string | undefined {
    return (
      this.keyOverride?.trim() ||
      process.env.KYC_ENCRYPTION_KEY?.trim() ||
      process.env.VAULT_MASTER_KEY?.trim() ||
      undefined
    );
  }

  isConfigured(): boolean {
    return Boolean(this.resolveKey());
  }

  /** Serialise and encrypt a KYC payload for storage. */
  encryptPayload(payload: KycPayload): string {
    const key = this.resolveKey();
    if (!key) {
      throw new KycEncryptionError(
        "KYC_ENCRYPTION_KEY (or VAULT_MASTER_KEY) is not configured",
      );
    }
    return encrypt(JSON.stringify(payload), key);
  }

  /** Decrypt a stored payload back into the original KYC field map. */
  decryptPayload(ciphertext: string): KycPayload {
    const key = this.resolveKey();
    if (!key) {
      throw new KycEncryptionError(
        "KYC_ENCRYPTION_KEY (or VAULT_MASTER_KEY) is not configured",
      );
    }
    if (!ciphertext) {
      throw new KycEncryptionError("Encrypted KYC payload is empty");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decrypt(ciphertext, key));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new KycEncryptionError(`Unable to decrypt KYC payload: ${message}`);
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new KycEncryptionError(
        "Decrypted KYC payload is not a JSON object",
      );
    }

    return parsed as KycPayload;
  }
}

export const kycEncryptionService = new KycEncryptionService();
