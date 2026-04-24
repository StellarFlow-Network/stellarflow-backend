/**
 * Property-based tests for SecretManager
 * Requirements: 10.1, 10.2, 10.3
 *
 * Feature: dynamic-secret-key-reload
 */

import * as fc from "fast-check";
import { Keypair } from "@stellar/stellar-sdk";

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Generates valid Stellar secret keys */
const validStellarKeyArb = fc
  .constant(null)
  .map(() => Keypair.random().secret());

/** Generates strings that are NOT valid Stellar secret keys */
const invalidKeyArb = fc.oneof(
  // empty string
  fc.constant(""),
  // whitespace-only strings
  fc
    .array(fc.constantFrom(" ", "\t", "\n", "\r"), {
      minLength: 1,
      maxLength: 10,
    })
    .map((chars) => chars.join("")),
  // arbitrary strings that fail Keypair.fromSecret
  fc.string({ minLength: 1 }).filter((s) => {
    if (s.trim().length === 0) return false; // handled by whitespace case
    try {
      Keypair.fromSecret(s);
      return false; // valid key — exclude
    } catch {
      return true;
    }
  }),
);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function freshModule() {
  jest.resetModules();
  return import("../src/services/secretManager");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SecretManager property-based tests", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    jest.resetModules();
  });

  // ── Property 1: Key initialization round-trip ─────────────────────────────
  // Validates: Requirements 1.1, 1.3
  it("Property 1: valid key set as ORACLE_SECRET_KEY is returned by getSecretKey()", async () => {
    await fc.assert(
      fc.asyncProperty(validStellarKeyArb, async (key) => {
        jest.resetModules();
        process.env.ORACLE_SECRET_KEY = key;
        delete process.env.SOROBAN_ADMIN_SECRET;

        const { getSecretKey } = await import("../src/services/secretManager");
        return getSecretKey() === key;
      }),
      { numRuns: 100 },
    );
  });

  // ── Property 2: Key update round-trip ────────────────────────────────────
  // Validates: Requirements 1.2, 3.3
  it("Property 2: any valid key passed to updateSecretKey is returned by getSecretKey()", async () => {
    const seedKey = Keypair.random().secret();
    process.env.ORACLE_SECRET_KEY = seedKey;

    const { getSecretKey, updateSecretKey } = await freshModule();

    fc.assert(
      fc.property(validStellarKeyArb, (key) => {
        updateSecretKey(key);
        return getSecretKey() === key;
      }),
      { numRuns: 100 },
    );
  });

  // ── Property 3: Invalid key rejected and previous key preserved ───────────
  // Validates: Requirements 2.2, 2.3, 2.4
  it("Property 3: invalid key causes updateSecretKey to throw and getSecretKey returns prior key", async () => {
    const seedKey = Keypair.random().secret();
    process.env.ORACLE_SECRET_KEY = seedKey;

    const { getSecretKey, updateSecretKey } = await freshModule();

    fc.assert(
      fc.property(invalidKeyArb, (badKey) => {
        const before = getSecretKey();
        let threw = false;
        try {
          updateSecretKey(badKey);
        } catch {
          threw = true;
        }
        return threw && getSecretKey() === before;
      }),
      { numRuns: 100 },
    );
  });

  // ── Property 4: Validation error message never contains the candidate key ─
  // Validates: Requirements 2.2, 8.3
  it("Property 4: error thrown for invalid key does not include the candidate value", async () => {
    const seedKey = Keypair.random().secret();
    process.env.ORACLE_SECRET_KEY = seedKey;

    const { updateSecretKey } = await freshModule();

    fc.assert(
      fc.property(
        // Use strings of at least 8 chars that are invalid Stellar keys.
        // Short strings (e.g. "I") may appear as substrings in the fixed error
        // message text itself, causing false positives.
        fc.string({ minLength: 8 }).filter((s) => {
          if (s.trim().length === 0) return false;
          try {
            Keypair.fromSecret(s);
            return false;
          } catch {
            return true;
          }
        }),
        (badKey) => {
          try {
            updateSecretKey(badKey);
            return false; // should have thrown
          } catch (e: any) {
            return !e.message.includes(badKey);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Property 11: process.env is not mutated by key updates ───────────────
  // Validates: Requirements 7.3
  it("Property 11: ORACLE_SECRET_KEY and SOROBAN_ADMIN_SECRET in process.env are unchanged after updateSecretKey", async () => {
    const seedKey = Keypair.random().secret();
    process.env.ORACLE_SECRET_KEY = seedKey;

    const { updateSecretKey } = await freshModule();

    fc.assert(
      fc.property(validStellarKeyArb, (key) => {
        const beforeOracle = process.env.ORACLE_SECRET_KEY;
        const beforeAdmin = process.env.SOROBAN_ADMIN_SECRET;
        updateSecretKey(key);
        return (
          process.env.ORACLE_SECRET_KEY === beforeOracle &&
          process.env.SOROBAN_ADMIN_SECRET === beforeAdmin
        );
      }),
      { numRuns: 100 },
    );
  });

  // ── Property 12: Reload count is monotonically increasing ────────────────
  // Validates: Requirements 9.3
  it("Property 12: after N successful updateSecretKey calls, getReloadCount equals prior count + N", async () => {
    const seedKey = Keypair.random().secret();
    process.env.ORACLE_SECRET_KEY = seedKey;

    const { getReloadCount, updateSecretKey } = await freshModule();

    fc.assert(
      fc.property(
        fc.array(validStellarKeyArb, { minLength: 1, maxLength: 20 }),
        (keys) => {
          const before = getReloadCount();
          keys.forEach((k) => updateSecretKey(k));
          return getReloadCount() === before + keys.length;
        },
      ),
      { numRuns: 100 },
    );
  });

  // ── Property 13: Successful reload log contains public key, not secret key ─
  // Validates: Requirements 9.1, 8.1
  it("Property 13: INFO log on successful update contains public key and not the secret key", async () => {
    const seedKey = Keypair.random().secret();
    process.env.ORACLE_SECRET_KEY = seedKey;

    const { updateSecretKey } = await freshModule();

    const loggedMessages: string[] = [];
    const originalInfo = console.info;
    console.info = (...args: any[]) => {
      loggedMessages.push(args.join(" "));
    };

    try {
      fc.assert(
        fc.property(validStellarKeyArb, (key) => {
          loggedMessages.length = 0;
          updateSecretKey(key);

          const combined = loggedMessages.join(" ");
          const expectedPublicKey = Keypair.fromSecret(key).publicKey();

          return (
            combined.includes(expectedPublicKey) && !combined.includes(key)
          );
        }),
        { numRuns: 100 },
      );
    } finally {
      console.info = originalInfo;
    }
  });

  // ── Property 14: Failed reload log contains reason, not candidate key ─────
  // Validates: Requirements 9.2, 8.1
  it("Property 14: WARN log on failed update contains rejection reason and not the candidate key", async () => {
    const seedKey = Keypair.random().secret();
    process.env.ORACLE_SECRET_KEY = seedKey;

    const { updateSecretKey } = await freshModule();

    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnMessages.push(args.join(" "));
    };

    try {
      fc.assert(
        fc.property(
          // Use strings of at least 8 chars that are invalid Stellar keys.
          // This avoids false positives where a short candidate (e.g. "I") is a
          // substring of the fixed error message text itself.
          fc.string({ minLength: 8 }).filter((s) => {
            if (s.trim().length === 0) return false;
            try {
              Keypair.fromSecret(s);
              return false;
            } catch {
              return true;
            }
          }),
          (badKey) => {
            warnMessages.length = 0;
            try {
              updateSecretKey(badKey);
            } catch {
              // expected
            }

            const combined = warnMessages.join(" ");
            const hasReason =
              combined.includes("Invalid Stellar secret key format") ||
              combined.includes("Secret key must not be empty");
            const doesNotContainKey = !combined.includes(badKey);

            return hasReason && doesNotContainKey;
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});
