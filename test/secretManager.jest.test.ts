/**
 * Unit tests for SecretManager
 * Requirements: 10.1, 10.2, 10.3
 */

import { Keypair } from "@stellar/stellar-sdk";

// A stable valid key for use across tests
const VALID_KEY_A = Keypair.random().secret();
const VALID_KEY_B = Keypair.random().secret();

describe("SecretManager", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env and reset module registry so each test gets a fresh module
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    jest.resetModules();
  });

  async function loadModule() {
    return import("../src/services/secretManager");
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  it("returns the key from ORACLE_SECRET_KEY on startup (Requirement 1.3)", async () => {
    process.env.ORACLE_SECRET_KEY = VALID_KEY_A;
    delete process.env.SOROBAN_ADMIN_SECRET;

    const { getSecretKey } = await loadModule();
    expect(getSecretKey()).toBe(VALID_KEY_A);
  });

  it("falls back to SOROBAN_ADMIN_SECRET when ORACLE_SECRET_KEY is absent (Requirement 1.3)", async () => {
    delete process.env.ORACLE_SECRET_KEY;
    process.env.SOROBAN_ADMIN_SECRET = VALID_KEY_B;

    const { getSecretKey } = await loadModule();
    expect(getSecretKey()).toBe(VALID_KEY_B);
  });

  it("throws when neither env var is set (Requirement 1.4)", async () => {
    delete process.env.ORACLE_SECRET_KEY;
    delete process.env.SOROBAN_ADMIN_SECRET;

    await expect(loadModule()).rejects.toThrow(
      "Stellar secret key not found in environment variables",
    );
  });

  // ── updateSecretKey ─────────────────────────────────────────────────────────

  it("updateSecretKey with a valid key causes getSecretKey to return the new key (Requirement 1.2)", async () => {
    process.env.ORACLE_SECRET_KEY = VALID_KEY_A;

    const { getSecretKey, updateSecretKey } = await loadModule();
    updateSecretKey(VALID_KEY_B);
    expect(getSecretKey()).toBe(VALID_KEY_B);
  });

  it("updateSecretKey with an empty string throws and leaves the key unchanged (Requirement 2.3)", async () => {
    process.env.ORACLE_SECRET_KEY = VALID_KEY_A;

    const { getSecretKey, updateSecretKey } = await loadModule();
    expect(() => updateSecretKey("")).toThrow("Secret key must not be empty");
    expect(getSecretKey()).toBe(VALID_KEY_A);
  });

  it("updateSecretKey with whitespace-only string throws and leaves the key unchanged (Requirement 2.3)", async () => {
    process.env.ORACLE_SECRET_KEY = VALID_KEY_A;

    const { getSecretKey, updateSecretKey } = await loadModule();
    expect(() => updateSecretKey("   ")).toThrow(
      "Secret key must not be empty",
    );
    expect(getSecretKey()).toBe(VALID_KEY_A);
  });

  it("updateSecretKey with an invalid strkey throws and leaves the key unchanged (Requirement 2.2)", async () => {
    process.env.ORACLE_SECRET_KEY = VALID_KEY_A;

    const { getSecretKey, updateSecretKey } = await loadModule();
    expect(() => updateSecretKey("NOTAVALIDKEY")).toThrow(
      "Invalid Stellar secret key format",
    );
    expect(getSecretKey()).toBe(VALID_KEY_A);
  });

  // ── getReloadCount ──────────────────────────────────────────────────────────

  it("getReloadCount starts at 0 and increments on each successful update (Requirement 9.3)", async () => {
    process.env.ORACLE_SECRET_KEY = VALID_KEY_A;

    const { getReloadCount, updateSecretKey } = await loadModule();
    expect(getReloadCount()).toBe(0);

    updateSecretKey(VALID_KEY_B);
    expect(getReloadCount()).toBe(1);

    updateSecretKey(VALID_KEY_A);
    expect(getReloadCount()).toBe(2);
  });

  it("getReloadCount does not increment on a failed update (Requirement 9.3)", async () => {
    process.env.ORACLE_SECRET_KEY = VALID_KEY_A;

    const { getReloadCount, updateSecretKey } = await loadModule();
    expect(getReloadCount()).toBe(0);

    expect(() => updateSecretKey("bad-key")).toThrow();
    expect(getReloadCount()).toBe(0);
  });

  // ── getPublicKey ────────────────────────────────────────────────────────────

  it("getPublicKey returns the correct public key derived from the active secret (Requirement 9.1)", async () => {
    process.env.ORACLE_SECRET_KEY = VALID_KEY_A;

    const { getPublicKey } = await loadModule();
    const expected = Keypair.fromSecret(VALID_KEY_A).publicKey();
    expect(getPublicKey()).toBe(expected);
  });

  it("getPublicKey reflects the new key after a successful update", async () => {
    process.env.ORACLE_SECRET_KEY = VALID_KEY_A;

    const { getPublicKey, updateSecretKey } = await loadModule();
    updateSecretKey(VALID_KEY_B);
    const expected = Keypair.fromSecret(VALID_KEY_B).publicKey();
    expect(getPublicKey()).toBe(expected);
  });
});
