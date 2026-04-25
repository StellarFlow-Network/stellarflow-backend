# Implementation Plan: Dynamic Secret Key Reload

## Overview

Implement runtime secret key rotation for StellarFlow by introducing a `SecretManager` singleton, refactoring `StellarService` to read the key at sign time, adding an admin HTTP endpoint, and an optional `.env` file watcher.

## Tasks

- [x] 1. Implement SecretManager module
  - Create `src/services/secretManager.ts` as a module-level singleton (matching the pattern in `appState.ts`)
  - Implement `getSecretKey()`, `updateSecretKey()`, `getReloadCount()`, `getPublicKey()`, and `ReloadTrigger` type
  - Initialize from `process.env.ORACLE_SECRET_KEY` || `process.env.SOROBAN_ADMIN_SECRET` at module load; throw `"Stellar secret key not found in environment variables"` if neither is set
  - Implement internal `validateKey()` using `Keypair.fromSecret` in a try/catch; throw `"Secret key must not be empty"` for empty/whitespace, `"Invalid Stellar secret key format"` for invalid strkey
  - On successful update: increment `reloadCount`, emit INFO log with trigger, public key, reloadCount, and timestamp — never log the secret key value
  - On failed update: emit WARN log with trigger and reason — never log the candidate key value
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 8.1, 8.3, 8.4, 9.1, 9.2, 9.3_

  - [ ]\* 1.1 Write unit tests for SecretManager (`test/secretManager.jest.test.ts`)
    - Test `getSecretKey()` returns key from `ORACLE_SECRET_KEY` on startup
    - Test fallback to `SOROBAN_ADMIN_SECRET` when `ORACLE_SECRET_KEY` is absent
    - Test module throws `"Stellar secret key not found in environment variables"` when neither env var is set
    - Test `updateSecretKey` with valid key succeeds and `getSecretKey` returns new key
    - Test `getReloadCount()` starts at 0 and increments on each successful update
    - Test `getPublicKey()` returns correct public key derived from active secret
    - _Requirements: 10.1, 10.2, 10.3_

  - [ ]\* 1.2 Write property tests for SecretManager (`test/secretManagerProps.jest.test.ts`)
    - **Property 1: Key initialization round-trip** — valid key set as `ORACLE_SECRET_KEY` is returned by `getSecretKey()` — **Validates: Requirements 1.1, 1.3**
    - **Property 2: Key update round-trip** — any valid key passed to `updateSecretKey` is returned by all subsequent `getSecretKey()` calls — **Validates: Requirements 1.2, 3.3**
    - **Property 3: Invalid key rejected and previous key preserved** — any invalid string causes `updateSecretKey` to throw and `getSecretKey()` still returns the prior key — **Validates: Requirements 2.2, 2.3, 2.4**
    - **Property 4: Validation error message never contains the candidate key** — error thrown for any invalid key does not include the candidate value as a substring — **Validates: Requirements 2.2, 8.3**
    - **Property 11: process.env not mutated** — `ORACLE_SECRET_KEY` and `SOROBAN_ADMIN_SECRET` in `process.env` are unchanged after any `updateSecretKey` call — **Validates: Requirements 7.3**
    - **Property 12: Reload count is monotonically increasing** — after N successful `updateSecretKey` calls, `getReloadCount()` equals the prior count plus N — **Validates: Requirements 9.3**
    - **Property 13: Successful reload log contains public key, not secret key** — INFO log entry contains the derived public key and does not contain the secret key value — **Validates: Requirements 9.1, 8.1**
    - **Property 14: Failed reload log contains reason, not candidate key** — WARN log entry contains the rejection reason and does not contain the rejected candidate key value — **Validates: Requirements 9.2, 8.1**
    - Use `fast-check` arbitraries: `validStellarKeyArb = fc.constant(null).map(() => Keypair.random().secret())` and `invalidKeyArb` covering empty, whitespace-only, and non-strkey strings
    - _Requirements: 10.1, 10.2, 10.3_

- [x] 2. Refactor StellarService to use SecretManager
  - Import `getSecretKey` from `secretManager.ts` in `src/services/stellarService.ts`
  - Remove the `this.keypair` field and the constructor-time `Keypair.fromSecret` call
  - Add a private `getKeypair(): Keypair` method that calls `Keypair.fromSecret(getSecretKey())` at sign time
  - Replace all uses of `this.keypair` in `submitTransactionWithRetries` and `submitMultiSignedTransaction` with `this.getKeypair()`
  - Keep all public method signatures (`submitPriceUpdate`, `submitBatchedPriceUpdates`, `submitMultiSignedPriceUpdate`) unchanged
  - _Requirements: 4.1, 4.2, 4.3, 7.1, 7.2_

- [x] 3. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Add admin reload endpoint
  - Add a `POST /api/admin/reload-secret` handler to `src/routes/admin.ts`
  - Guard the route with `adminMiddleware` (already applied to `/api/admin` in `app.ts`)
  - If `req.body.secretKey` is present, call `updateSecretKey(req.body.secretKey, "admin-endpoint")`; otherwise re-read `process.env.ORACLE_SECRET_KEY || process.env.SOROBAN_ADMIN_SECRET` and call `updateSecretKey`
  - On success: respond `200 { success: true, message: "Secret key reloaded successfully" }`
  - On validation error: respond `400 { success: false, error: "<message>" }`
  - On unexpected error: respond `500 { success: false, error: "Failed to reload secret key" }`
  - Never echo or log the received key value in any response field or header
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 8.2_

  - [ ]\* 4.1 Write integration tests for admin endpoint (`test/adminReloadSecret.jest.test.ts`)
    - Test authorized request with valid `secretKey` body → HTTP 200
    - Test authorized request without `secretKey` body → re-reads env, HTTP 200
    - Test unauthorized request (wrong `x-admin-key`) → HTTP 403
    - Test authorized request with invalid `secretKey` → HTTP 400
    - Test response body never contains the submitted key value
    - **Property 5: Unauthorized requests are rejected** — any request without valid `ADMIN_API_KEY` or from non-whitelisted IP returns 403 — **Validates: Requirements 5.2**
    - **Property 6: Valid key returns 200 and key is not echoed** — any valid key in request body yields 200 `{ success: true }` with no key value in response — **Validates: Requirements 5.3, 5.7, 8.2**
    - **Property 7: Invalid key in request body returns 400** — any invalid key string in body yields 400 `{ success: false, error: "..." }` — **Validates: Requirements 5.5**
    - _Requirements: 10.4, 10.5, 10.6_

- [x] 5. Implement EnvFileWatcher
  - Create `src/config/envFileWatcher.ts` mirroring the pattern of `configWatcher.ts`
  - Export `startEnvFileWatcher(): () => void`
  - Use `fs.watch` on `.env` in `process.cwd()`; return a no-op cleanup if `.env` does not exist (log a warning)
  - Debounce change events with a 500 ms timer (clear and reset on each event)
  - On fire: read `.env` with `dotenv.parse`, extract `ORACLE_SECRET_KEY` or `SOROBAN_ADMIN_SECRET`, call `updateSecretKey(newKey, "file-watcher")` if valid
  - If key is missing or invalid, catch the error/absence, log at WARN level, and do not update
  - Return `watcher.close()` as the cleanup function
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]\* 5.1 Write unit tests for EnvFileWatcher (`test/envFileWatcher.jest.test.ts`)
    - Test watcher calls `updateSecretKey` when a valid key is written to `.env`
    - Test watcher does not call `updateSecretKey` when an invalid key is written
    - Test debounce: rapid events result in a single `updateSecretKey` call
    - Test watcher returns a no-op cleanup when `.env` does not exist
    - **Property 8: File watcher calls updateSecretKey for valid key changes** — any valid key written to `.env` triggers `updateSecretKey` within the debounce window — **Validates: Requirements 6.2, 6.3**
    - **Property 9: File watcher does not call updateSecretKey for invalid key changes** — any invalid/missing key in `.env` does not trigger `updateSecretKey` — **Validates: Requirements 6.4**
    - **Property 10: Debounce prevents redundant reloads** — any sequence of rapid change events within 500 ms results in at most one `updateSecretKey` call — **Validates: Requirements 6.5**
    - _Requirements: 10.7, 10.8_

- [x] 6. Wire EnvFileWatcher into server startup and shutdown
  - In `src/index.ts`, import `startEnvFileWatcher` from `src/config/envFileWatcher.ts`
  - After the existing `watchConfig` call, conditionally start the watcher: `if (process.env.ENABLE_ENV_FILE_WATCHER === "true") { stopEnvFileWatcher = startEnvFileWatcher(); }`
  - Store the returned cleanup function and call it inside the `shutdown` function alongside `stopConfigWatcher()`
  - _Requirements: 6.6, 7.1_

- [x] 7. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Install `fast-check` before running property tests: `npm install --save-dev fast-check`
- Each task references specific requirements for traceability
- Property tests use a minimum of 100 iterations (`numRuns: 100`)
- The secret key value must never appear in logs, responses, or error messages
