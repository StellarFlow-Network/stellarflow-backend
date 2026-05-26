# Contract Sanity Check Implementation

## Overview

This implementation adds a state-sanity check on startup for the StellarFlow backend to prevent silent failures when the target smart contract has been redeployed or upgraded on Testnet.

## Problem Statement

If the target smart contract has been redeployed or upgraded on Testnet, a mismatch between the backend's expected contract ID and the ledger will break operations silently. The backend would continue running but fail to interact with the contract properly.

## Solution

Implemented an on-startup sanity check that performs a low-cost read on the target contract ID before starting the ingestion loop. If the contract fails to respond or returns unexpected structural data, the backend ingestion loop is prevented from starting.

## Technical Implementation

### 1. Environment Variable Configuration

Added `CONTRACT_ID` to `.env.example`:

```bash
# Soroban Contract Configuration
# Target smart contract ID for state sanity checks on startup
CONTRACT_ID=your_contract_id_here
```

### 2. Contract Sanity Check Service

Created `src/services/contractSanityCheckService.ts` with the following features:

- **Low-cost contract reads**: Attempts to read contract version or active status
- **Dual fallback strategy**: Tries `get_version` first, falls back to `is_active` check
- **Network-aware**: Automatically uses correct RPC endpoint based on `STELLAR_NETWORK`
- **Graceful degradation**: Allows startup if `CONTRACT_ID` is not configured (backward compatibility)
- **Error handling**: Provides detailed error messages for debugging

#### Key Methods

- `performSanityCheck()`: Main entry point for contract validation
- `tryGetVersion()`: Attempts to read contract version (low-cost read)
- `tryIsActive()`: Fallback method to check if contract exists and is active
- `isConfigured()`: Checks if CONTRACT_ID is set

### 3. Startup Integration

Modified `src/index.ts` to integrate the sanity check:

1. **Import the service**:
```typescript
import { contractSanityCheckService } from "./services/contractSanityCheckService";
```

2. **Perform check before ingestion loop**:
```typescript
// Perform contract sanity check before starting ingestion loop
let contractSanityPassed = true;
if (contractSanityCheckService.isConfigured()) {
  try {
    const sanityResult = await contractSanityCheckService.performSanityCheck();
    if (!sanityResult.success) {
      console.error(`❌ Contract sanity check failed: ${sanityResult.error}`);
      console.error("⛔ Preventing ingestion loop from starting due to contract failure");
      contractSanityPassed = false;
    }
  } catch (err) {
    console.error("❌ Contract sanity check error:", err);
    console.error("⛔ Preventing ingestion loop from starting due to contract check error");
    contractSanityPassed = false;
  }
}
```

3. **Conditional ingestion loop start**:
```typescript
// Start Soroban event listener to track confirmed on-chain prices
// Only start if contract sanity check passed or if check is not configured
if (contractSanityPassed) {
  try {
    sorobanEventListener = new SorobanEventListener();
    sorobanEventListener.start().catch((err) => {
      console.error("Failed to start event listener:", err);
    });
    console.log(`👂 Soroban event listener started`);
  } catch (err) {
    console.warn("Event listener not started:", err);
    sorobanEventListener = null;
  }
} else {
  console.warn("⚠️ Soroban event listener NOT started due to failed contract sanity check");
}
```

## Usage

### Configuration

1. Add your contract ID to `.env`:
```bash
CONTRACT_ID=CDLZFC3SYJNHZV5DQJZ5YIQ5ZG4YMJF5JXK7HNXATFQ4J3E2B5S7V4N
```

2. Set the network (if not already set):
```bash
STELLAR_NETWORK=TESTNET
```

### Startup Behavior

#### Scenario 1: Contract Check Passes
```
🔍 Performing contract sanity check on CDLZFC3SYJNHZV5DQJZ5YIQ5ZG4YMJF5JXK7HNXATFQ4J3E2B5S7V4N (TESTNET)
✅ Contract sanity check passed - Version: 1.0.0
👂 Soroban event listener started
```

#### Scenario 2: Contract Check Fails
```
🔍 Performing contract sanity check on CDLZFC3SYJNHZV5DQJZ5YIQ5ZG4YMJF5JXK7HNXATFQ4J3E2B5S7V4N (TESTNET)
❌ Contract sanity check failed: Contract not found on ledger
⛔ Preventing ingestion loop from starting due to contract failure
⚠️ Soroban event listener NOT started due to failed contract sanity check
```

#### Scenario 3: CONTRACT_ID Not Configured
```
ℹ️ CONTRACT_ID not configured - skipping contract sanity check (ingestion loop will start)
👂 Soroban event listener started
```

## Technical Details

### RPC Endpoints

The service automatically selects the correct RPC endpoint based on the network:

- **TESTNET**: `https://rpc.testnet.stellar.org`
- **PUBLIC**: `https://rpc.mainnet.stellar.org`

### Contract Read Operations

The service attempts two types of low-cost reads:

1. **Version Read**: Attempts to read a `version` function from the contract
2. **Active Check**: Falls back to checking if the contract code exists on the ledger

### Error Handling

The service handles various error scenarios:

- **Contract not found**: Indicates contract was redeployed with new ID
- **Network errors**: RPC connectivity issues
- **Timeout**: Contract not responding within 10 seconds
- **Invalid response**: Contract returns unexpected data structure

## Benefits

1. **Early detection**: Catches contract mismatches at startup before processing data
2. **Silent failure prevention**: Prevents backend from running with broken contract configuration
3. **Backward compatibility**: Allows operation without CONTRACT_ID for existing deployments
4. **Clear logging**: Provides detailed error messages for debugging
5. **Low overhead**: Uses low-cost read operations that don't consume significant resources

## Testing

To test the implementation:

1. **Valid Contract ID**:
   - Set `CONTRACT_ID` to a valid contract on the network
   - Start the backend
   - Verify the sanity check passes and ingestion loop starts

2. **Invalid Contract ID**:
   - Set `CONTRACT_ID` to an invalid/non-existent contract
   - Start the backend
   - Verify the sanity check fails and ingestion loop does not start

3. **No Contract ID**:
   - Remove or comment out `CONTRACT_ID`
   - Start the backend
   - Verify the check is skipped and ingestion loop starts normally

## Future Enhancements

Potential improvements for future iterations:

1. **Automatic contract ID discovery**: Fetch contract ID from a configuration service
2. **Contract version validation**: Compare contract version against expected version
3. **Retry mechanism**: Add retry logic for transient network failures
4. **Health check endpoint**: Expose contract status via `/health` endpoint
5. **Alert integration**: Send alerts when contract sanity check fails

## Files Modified

- `.env.example`: Added CONTRACT_ID configuration
- `src/index.ts`: Integrated sanity check into startup process
- `src/services/contractSanityCheckService.ts`: New service file

## Dependencies

Uses existing `@stellar/stellar-sdk` package for Soroban RPC interactions. No additional dependencies required.
