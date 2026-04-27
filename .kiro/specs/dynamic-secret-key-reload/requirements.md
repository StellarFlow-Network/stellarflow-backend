# Requirements Document

## Introduction

StellarFlow currently loads the Stellar secret key (used for signing transactions and price updates) once at server startup from environment variables. This feature introduces a mechanism to reload the secret key at runtime without restarting the server. The solution must maintain strong security guarantees, prevent race conditions during key transitions, and preserve full backward compatibility with existing signing flows (price updates, batched updates, multi-sig operations).

## Glossary

- **Secret_Manager**: The centralized in-memory module (`secretManager.ts`) responsible for storing, validating, and providing access to the active Stellar secret key.
- **Secret_Key**: A Stellar Ed25519 secret key in strkey format (starts with `S`), used to sign transactions submitted to the Stellar network.
- **Reload_Trigger**: The mechanism that initiates a secret key refresh — either via the admin HTTP endpoint or a file watcher.
- **Admin_Endpoint**: The HTTP route `POST /api/admin/reload-secret` that authorized callers use to trigger a key reload.
- **File_Watcher**: An `fs.watch`-based observer that detects changes to the `.env` file and triggers a key reload.
- **Stellar_Service**: The existing `StellarService` class in `src/services/stellarService.ts` that signs and submits transactions to the Stellar network.
- **Admin_Middleware**: The existing `adminMiddleware` in `src/middleware/adminMiddleware.ts` that enforces `ADMIN_API_KEY` and `ADMIN_IP` checks on admin routes.
- **Key_Validator**: The internal function within Secret_Manager that validates a candidate secret key before it is applied.

---

## Requirements

### Requirement 1: Centralized Secret Manager

**User Story:** As a backend engineer, I want all secret key access to go through a single module, so that key updates are reflected immediately across the entire system without modifying multiple call sites.

#### Acceptance Criteria

1. THE Secret_Manager SHALL expose a `getSecretKey(): string` function that returns the currently active Stellar secret key.
2. THE Secret_Manager SHALL expose an `updateSecretKey(newKey: string): void` function that replaces the in-memory key after validation.
3. THE Secret_Manager SHALL initialize the in-memory key from `process.env.ORACLE_SECRET_KEY` or `process.env.SOROBAN_ADMIN_SECRET` on module load, preserving the existing fallback order used by `StellarService`.
4. IF neither `ORACLE_SECRET_KEY` nor `SOROBAN_ADMIN_SECRET` is set at initialization, THEN THE Secret_Manager SHALL throw an error with the message `"Stellar secret key not found in environment variables"`.
5. THE Secret_Manager SHALL never expose the raw secret key value in log output, error messages, or serialized responses.

---

### Requirement 2: Key Format Validation

**User Story:** As a security engineer, I want invalid or malformed keys to be rejected before they are applied, so that the system never enters a state where it holds an unusable or dangerous key.

#### Acceptance Criteria

1. WHEN `updateSecretKey` is called with a candidate key, THE Key_Validator SHALL verify the key is a valid Stellar strkey secret (parseable by `Keypair.fromSecret`) before applying it.
2. IF the candidate key fails Stellar strkey validation, THEN THE Key_Validator SHALL throw an error with the message `"Invalid Stellar secret key format"` and SHALL NOT update the in-memory key.
3. IF the candidate key is an empty string or contains only whitespace, THEN THE Key_Validator SHALL throw an error with the message `"Secret key must not be empty"` and SHALL NOT update the in-memory key.
4. WHEN a key update is rejected, THE Secret_Manager SHALL retain the previously active key unchanged.

---

### Requirement 3: Concurrency Safety During Key Updates

**User Story:** As a backend engineer, I want key updates to be atomic with respect to in-flight signing operations, so that no transaction is signed with a partially-applied or inconsistent key.

#### Acceptance Criteria

1. THE Secret_Manager SHALL store the active key as a single atomic reference such that any call to `getSecretKey()` returns either the fully old key or the fully new key, never an intermediate state.
2. WHILE a key update is in progress, THE Secret_Manager SHALL ensure that concurrent calls to `getSecretKey()` return a consistent key value (either the previous key or the new key, not undefined or null).
3. WHEN `updateSecretKey` completes successfully, THE Secret_Manager SHALL guarantee that all subsequent calls to `getSecretKey()` return the new key.

---

### Requirement 4: Stellar Service Integration

**User Story:** As a backend engineer, I want `StellarService` to use the Secret_Manager for key access, so that key reloads are automatically reflected in all signing operations without restarting the service.

#### Acceptance Criteria

1. THE Stellar_Service SHALL retrieve the active secret key via `getSecretKey()` from Secret_Manager at the point of signing each transaction, rather than reading from `process.env` at construction time.
2. WHEN a key reload occurs between two consecutive signing operations, THE Stellar_Service SHALL use the updated key for all signing operations that begin after the reload completes.
3. THE Stellar_Service SHALL maintain backward compatibility: existing public method signatures (`submitPriceUpdate`, `submitBatchedPriceUpdates`, `submitMultiSignedPriceUpdate`) SHALL remain unchanged.

---

### Requirement 5: Admin Reload Endpoint

**User Story:** As an operations engineer, I want a secure HTTP endpoint to trigger a secret key reload, so that I can rotate the key in production without downtime.

#### Acceptance Criteria

1. THE Admin_Endpoint SHALL accept `POST /api/admin/reload-secret` requests.
2. WHEN a request reaches `POST /api/admin/reload-secret`, THE Admin_Middleware SHALL enforce existing `ADMIN_API_KEY` and `ADMIN_IP` authorization checks before the reload logic executes.
3. WHEN the request body contains a `secretKey` field, THE Admin_Endpoint SHALL pass the provided value to `updateSecretKey` and, on success, respond with HTTP 200 and `{ "success": true, "message": "Secret key reloaded successfully" }`.
4. WHEN the request body does not contain a `secretKey` field, THE Admin_Endpoint SHALL trigger a re-read of `process.env.ORACLE_SECRET_KEY` or `process.env.SOROBAN_ADMIN_SECRET` (re-sourcing from the environment) and respond with HTTP 200 on success.
5. IF `updateSecretKey` throws a validation error, THEN THE Admin_Endpoint SHALL respond with HTTP 400 and `{ "success": false, "error": "<validation error message>" }`.
6. IF an unexpected error occurs during reload, THEN THE Admin_Endpoint SHALL respond with HTTP 500 and `{ "success": false, "error": "Failed to reload secret key" }`.
7. THE Admin_Endpoint SHALL never include the secret key value in any HTTP response body or response header.

---

### Requirement 6: File Watcher Reload (Option A)

**User Story:** As an operations engineer, I want the server to detect `.env` file changes and automatically reload the secret key, so that key rotation can be performed by updating the file without any HTTP call.

#### Acceptance Criteria

1. THE File_Watcher SHALL monitor the `.env` file in the project root for change events using `fs.watch` or an equivalent Node.js file-watching API.
2. WHEN a change event is detected on the `.env` file, THE File_Watcher SHALL re-parse the file and extract the updated value of `ORACLE_SECRET_KEY` or `SOROBAN_ADMIN_SECRET`.
3. WHEN a valid updated key is found after a file change, THE File_Watcher SHALL call `updateSecretKey` with the new value.
4. IF the updated `.env` file contains an invalid or missing key, THEN THE File_Watcher SHALL log a warning and SHALL NOT update the in-memory key.
5. THE File_Watcher SHALL debounce file change events with a minimum interval of 500 milliseconds to prevent redundant reloads from rapid successive writes.
6. WHERE the application is started with `ENABLE_ENV_FILE_WATCHER=true`, THE File_Watcher SHALL be activated on server startup.

---

### Requirement 7: Backward Compatibility

**User Story:** As a backend engineer, I want all existing signing flows to continue working after this refactor, so that no currently-passing functionality is broken.

#### Acceptance Criteria

1. THE Secret_Manager SHALL be initialized before any `StellarService` instance is constructed, ensuring `getSecretKey()` is available at the time `StellarService` is first used.
2. WHEN the server starts without any reload trigger being invoked, THE Stellar_Service SHALL behave identically to its pre-refactor behavior, using the key sourced from environment variables.
3. THE Secret_Manager SHALL not alter or remove any existing environment variable (`ORACLE_SECRET_KEY`, `SOROBAN_ADMIN_SECRET`, `STELLAR_SECRET`) from `process.env`.

---

### Requirement 8: Security Constraints

**User Story:** As a security engineer, I want the secret key to be handled with strict security controls throughout its lifecycle, so that it is never inadvertently exposed.

#### Acceptance Criteria

1. THE Secret_Manager SHALL not write the secret key value to any log, console output, or external monitoring system at any point in its lifecycle.
2. WHEN the Admin_Endpoint receives a request containing a `secretKey` field, THE Admin_Endpoint SHALL not echo or log the received key value.
3. THE Key_Validator SHALL validate the key format using `Keypair.fromSecret` in a try/catch block and SHALL only propagate a generic format error message, not the key value itself.
4. WHERE the application runs in a Node.js environment, THE Secret_Manager SHOULD overwrite the previous key string reference to allow garbage collection after a successful update.

---

### Requirement 9: Observability

**User Story:** As an operations engineer, I want key reload events to be logged with sufficient context, so that I can audit when and how the key was changed.

#### Acceptance Criteria

1. WHEN a key reload succeeds, THE Secret_Manager SHALL emit a log entry at INFO level containing the timestamp, the trigger source (admin endpoint or file watcher), and the public key derived from the new secret key.
2. WHEN a key reload fails due to validation, THE Secret_Manager SHALL emit a log entry at WARN level containing the timestamp, the trigger source, and the rejection reason, but SHALL NOT include the rejected key value.
3. THE Secret_Manager SHALL track a reload counter that increments on each successful key update, accessible via a `getReloadCount(): number` function.

---

### Requirement 10: Testing Coverage

**User Story:** As a backend engineer, I want comprehensive tests for the secret manager and reload flows, so that regressions are caught before deployment.

#### Acceptance Criteria

1. THE Secret_Manager unit tests SHALL verify that `getSecretKey()` returns the initialized key on startup.
2. THE Secret_Manager unit tests SHALL verify that `updateSecretKey()` with a valid key causes subsequent `getSecretKey()` calls to return the new key.
3. THE Secret_Manager unit tests SHALL verify that `updateSecretKey()` with an invalid key throws the expected error and leaves the previous key unchanged.
4. THE Admin_Endpoint integration tests SHALL verify that an authorized request with a valid key returns HTTP 200.
5. THE Admin_Endpoint integration tests SHALL verify that an unauthorized request returns HTTP 403.
6. THE Admin_Endpoint integration tests SHALL verify that a request with an invalid key returns HTTP 400.
7. THE File_Watcher unit tests SHALL verify that a valid key change in `.env` triggers `updateSecretKey` with the new value.
8. THE File_Watcher unit tests SHALL verify that an invalid key in the updated `.env` does not call `updateSecretKey`.
