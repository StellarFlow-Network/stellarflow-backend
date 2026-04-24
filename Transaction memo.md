# Stellar Transaction Memo Tagging

This feature implements unique ID tagging for every price update submitted to the Stellar network. By including a structured ID in the transaction memo, auditing and tracking these updates on explorers like StellarExpert becomes significantly easier.

## Implementation Overview

### 1. StellarService

A new service (`src/services/stellarService.ts`) has been added to handle all interactions with the Stellar network. It encapsulates:

- **Transaction Building**: Uses `@stellar/stellar-sdk` to create transactions.
- **ManageData Operations**: Prices are submitted as `manageData` operations (e.g., `NGN_PRICE`).
- **Memo Tagging**: Each transaction includes a `MemoText` with a unique ID formatted as `SF-<CURRENCY>-<TIMESTAMP>-<RANDOM>`.
- **Dynamic Network Selection**: Supports both `TESTNET` and `PUBLIC` networks via environment variables.

### 2. MarketRateService Integration

The `MarketRateService` now utilizes the `StellarService` to broadcast price updates:

- Every time a fresh rate is fetched (not from cache), the service triggers a background update to the Stellar network.
- Failures in the Stellar broadcast are logged but do not block the API response, ensuring high availability.

## Benefits for Auditing

With unique memo IDs, auditors can:

- Filter transactions by the `SF-` prefix on StellarExpert.
- Correlate specific price points with their corresponding timestamps and sources.
- Verify the frequency and consistency of price updates directly on the blockchain.

## Configuration

To enable the Stellar integration, ensure the following environment variables are set:

- `ORACLE_SECRET_KEY` or `SOROBAN_ADMIN_SECRET`: The secret key for the oracle account.
- `STELLAR_NETWORK`: `TESTNET` (default) or `PUBLIC`.

issue #43
