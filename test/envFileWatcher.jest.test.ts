/**
 * Unit tests for EnvFileWatcher
 * Requirements: 10.7, 10.8, 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { Keypair } from "@stellar/stellar-sdk";
import * as fc from "fast-check";

// Stable valid keys for use across tests
const VALID_KEY_A = Keypair.random().secret();
const VALID_KEY_B = Keypair.random().secret();

const DEBOUNCE_MS = 500;

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock("fs");
jest.mock("../src/services/secretManager", () => ({
  updateSecretKey: jest.fn(),
}));

import fs from "fs";
import { updateSecretKey } from "../src/services/secretManager";

const mockFs = fs as jest.Mocked<typeof fs>;
const mockUpdateSecretKey = updateSecretKey as jest.MockedFunction<
  typeof updateSecretKey
>;

// Import the module under test once (mocks are already in place)
import { startEnvFileWatcher } from "../src/config/envFileWatcher";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sets up the fs.watch mock to capture the callback and returns a helper
 * to trigger it.
 */
function setupWatchMock(existsSync = true) {
  let capturedCallback: ((event: string) => void) | null = null;
  const mockWatcher = { close: jest.fn() };

  mockFs.existsSync.mockReturnValue(existsSync);
  (mockFs.watch as jest.Mock).mockImplementation(
    (_path: string, cb: (event: string) => void) => {
      capturedCallback = cb;
      return mockWatcher;
    },
  );

  return {
    trigger: (event = "change") => {
      if (!capturedCallback)
        throw new Error(
          "fs.watch callback not captured — was startEnvFileWatcher called?",
        );
      capturedCallback(event);
    },
    mockWatcher,
  };
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe("EnvFileWatcher", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockUpdateSecretKey.mockReset();
    (mockFs.watch as jest.Mock).mockReset();
    mockFs.existsSync.mockReset();
    (mockFs.readFileSync as jest.Mock).mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── No-op when .env does not exist ─────────────────────────────────────────

  it("returns a no-op cleanup when .env does not exist (Requirement 6.1)", () => {
    mockFs.existsSync.mockReturnValue(false);

    const cleanup = startEnvFileWatcher();

    expect(mockFs.watch).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });

  // ── Valid key triggers updateSecretKey ─────────────────────────────────────

  it("calls updateSecretKey when a valid key is written to .env (Requirement 6.2, 6.3)", () => {
    const { trigger } = setupWatchMock(true);
    mockFs.readFileSync.mockReturnValue(
      Buffer.from(`ORACLE_SECRET_KEY=${VALID_KEY_A}`),
    );

    startEnvFileWatcher();

    trigger("change");
    jest.advanceTimersByTime(DEBOUNCE_MS);

    expect(mockUpdateSecretKey).toHaveBeenCalledTimes(1);
    expect(mockUpdateSecretKey).toHaveBeenCalledWith(
      VALID_KEY_A,
      "file-watcher",
    );
  });

  it("uses SOROBAN_ADMIN_SECRET as fallback when ORACLE_SECRET_KEY is absent", () => {
    const { trigger } = setupWatchMock(true);
    mockFs.readFileSync.mockReturnValue(
      Buffer.from(`SOROBAN_ADMIN_SECRET=${VALID_KEY_B}`),
    );

    startEnvFileWatcher();

    trigger("change");
    jest.advanceTimersByTime(DEBOUNCE_MS);

    expect(mockUpdateSecretKey).toHaveBeenCalledWith(
      VALID_KEY_B,
      "file-watcher",
    );
  });

  // ── Invalid key does not trigger updateSecretKey ───────────────────────────

  it("does not call updateSecretKey when key is missing from .env (Requirement 6.4)", () => {
    const { trigger } = setupWatchMock(true);
    mockFs.readFileSync.mockReturnValue(Buffer.from(`SOME_OTHER_VAR=value`));

    startEnvFileWatcher();

    trigger("change");
    jest.advanceTimersByTime(DEBOUNCE_MS);

    expect(mockUpdateSecretKey).not.toHaveBeenCalled();
  });

  it("catches and does not crash when updateSecretKey throws for invalid key (Requirement 6.4)", () => {
    const { trigger } = setupWatchMock(true);
    mockUpdateSecretKey.mockImplementation(() => {
      throw new Error("Invalid Stellar secret key format");
    });
    mockFs.readFileSync.mockReturnValue(
      Buffer.from(`ORACLE_SECRET_KEY=NOTAVALIDKEY`),
    );

    startEnvFileWatcher();

    // Should not throw even though updateSecretKey throws
    expect(() => {
      trigger("change");
      jest.advanceTimersByTime(DEBOUNCE_MS);
    }).not.toThrow();
  });

  // ── Debounce ───────────────────────────────────────────────────────────────

  it("debounce: rapid events result in a single updateSecretKey call (Requirement 6.5)", () => {
    const { trigger } = setupWatchMock(true);
    mockFs.readFileSync.mockReturnValue(
      Buffer.from(`ORACLE_SECRET_KEY=${VALID_KEY_A}`),
    );

    startEnvFileWatcher();

    // Fire 5 rapid change events, each 100ms apart (within debounce window)
    for (let i = 0; i < 5; i++) {
      trigger("change");
      jest.advanceTimersByTime(100);
    }

    // Advance past the final debounce window
    jest.advanceTimersByTime(DEBOUNCE_MS);

    expect(mockUpdateSecretKey).toHaveBeenCalledTimes(1);
  });

  it("non-change events are ignored", () => {
    const { trigger } = setupWatchMock(true);
    mockFs.readFileSync.mockReturnValue(
      Buffer.from(`ORACLE_SECRET_KEY=${VALID_KEY_A}`),
    );

    startEnvFileWatcher();

    trigger("rename");
    jest.advanceTimersByTime(DEBOUNCE_MS);

    expect(mockUpdateSecretKey).not.toHaveBeenCalled();
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────

  it("returns watcher.close() as the cleanup function", () => {
    const { mockWatcher } = setupWatchMock(true);

    const cleanup = startEnvFileWatcher();

    cleanup();
    expect(mockWatcher.close).toHaveBeenCalledTimes(1);
  });

  // ── Property 8: valid key written to .env triggers updateSecretKey ─────────
  // Feature: dynamic-secret-key-reload, Property 8: File watcher calls updateSecretKey for valid key changes
  // Validates: Requirements 6.2, 6.3

  it("Property 8: any valid key written to .env triggers updateSecretKey", () => {
    const validKeyArb = fc.constant(null).map(() => Keypair.random().secret());

    fc.assert(
      fc.property(validKeyArb, (key) => {
        mockUpdateSecretKey.mockReset();

        const { trigger } = setupWatchMock(true);
        mockFs.readFileSync.mockReturnValue(
          Buffer.from(`ORACLE_SECRET_KEY=${key}`),
        );

        startEnvFileWatcher();
        trigger("change");
        jest.advanceTimersByTime(DEBOUNCE_MS);

        expect(mockUpdateSecretKey).toHaveBeenCalledWith(key, "file-watcher");
      }),
      { numRuns: 20 },
    );
  });

  // ── Property 9: invalid/missing key does not trigger updateSecretKey ────────
  // Feature: dynamic-secret-key-reload, Property 9: File watcher does not call updateSecretKey for invalid key changes
  // Validates: Requirements 6.4

  it("Property 9: invalid or missing key in .env does not trigger updateSecretKey", () => {
    const invalidEnvArb = fc.oneof(
      fc.constant("SOME_OTHER_VAR=value"),
      fc.constant(""),
      fc.constant("ORACLE_SECRET_KEY="),
    );

    fc.assert(
      fc.property(invalidEnvArb, (envContent) => {
        mockUpdateSecretKey.mockReset();

        const { trigger } = setupWatchMock(true);
        mockFs.readFileSync.mockReturnValue(Buffer.from(envContent));

        startEnvFileWatcher();
        trigger("change");
        jest.advanceTimersByTime(DEBOUNCE_MS);

        expect(mockUpdateSecretKey).not.toHaveBeenCalled();
      }),
      { numRuns: 20 },
    );
  });

  // ── Property 10: rapid change events result in at most one updateSecretKey call
  // Feature: dynamic-secret-key-reload, Property 10: Debounce prevents redundant reloads
  // Validates: Requirements 6.5

  it("Property 10: rapid change events within 500ms result in at most one updateSecretKey call", () => {
    const rapidEventsArb = fc.integer({ min: 2, max: 20 });

    fc.assert(
      fc.property(rapidEventsArb, (numEvents) => {
        mockUpdateSecretKey.mockReset();

        const { trigger } = setupWatchMock(true);
        mockFs.readFileSync.mockReturnValue(
          Buffer.from(`ORACLE_SECRET_KEY=${VALID_KEY_A}`),
        );

        startEnvFileWatcher();

        // Fire numEvents rapid change events, each 50ms apart (within debounce window)
        for (let i = 0; i < numEvents; i++) {
          trigger("change");
          jest.advanceTimersByTime(50);
        }

        // Advance past the final debounce window
        jest.advanceTimersByTime(DEBOUNCE_MS);

        expect(mockUpdateSecretKey.mock.calls.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 20 },
    );
  });
});
