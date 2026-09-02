# Cross-Chain Bridge Event Listener Service

## Overview

This service implements a cross-chain bridge event listener that monitors token lock events on external blockchain endpoints (EVM chains like Ethereum, Polygon) and triggers Soroban minting transactions on Stellar after validator signature verification.

## Architecture

### Components

1. **Bridge Event Listener** (`src/services/bridgeEventListener.ts`)
   - Polls EVM chain RPC endpoints for bridge contract events
   - Supports multiple chains simultaneously (Ethereum, Polygon, etc.)
   - Uses ethers.js for Web3 connectivity
   - Implements backpressure queue for event processing

2. **Signature Verification** (`src/services/bridgeSignatureVerification.ts`)
   - Verifies validator signatures for bridge events
   - Supports both EVM (ECDSA) and Stellar (Ed25519) signature schemes
   - Implements weighted threshold verification (default 2/3)
   - Prevents duplicate signatures from same validator

3. **Soroban Minting Service** (`src/services/bridgeMintingService.ts`)
   - Stages Soroban minting transactions for verified events
   - Simulates transactions before submission
   - Handles transaction signing and submission
   - Manages transaction confirmation polling

4. **PostgreSQL Queue** (`src/services/bridgeQueueService.ts`)
   - Priority-based queue for bridge operations
   - Automatic retry logic for failed operations
   - Queue statistics and monitoring
   - Cleanup of old completed operations

5. **API Routes** (`src/routes/bridge.ts`)
   - REST API for bridge management
   - Chain and validator configuration
   - Event monitoring and signature submission
   - Queue management and simulation

## Database Schema

### Models

- **BridgeChain**: Configured blockchain networks (EVM/Stellar)
- **BridgeValidator**: Validator nodes with signature weights
- **BridgeEvent**: Detected bridge events from external chains
- **BridgeValidatorSignature**: Validator signatures for events
- **BridgeOperation**: Queued minting operations for Soroban

## Setup Instructions

### 1. Database Migration

First, ensure your `.env` file has `DATABASE_URL` configured:

```bash
# Example DATABASE_URL
DATABASE_URL=postgresql://username:password@localhost:5432/stellarflow
```

Then run the database migration:

```bash
npm run db:push
```

### 2. Seed Bridge Configuration

Run the seed script to create initial bridge chains and validators:

```bash
npx tsx prisma/bridgeSeed.ts
```

**Important**: Update the seed script with actual:
- Bridge contract addresses
- Validator public keys/addresses
- RPC endpoints for your chains

### 3. Environment Configuration

Add the following to your `.env` file:

```bash
# Cross-Chain Bridge Configuration
SOROBAN_BRIDGE_CONTRACT_ID=your_soroban_bridge_contract_id_here
BRIDGE_EVENT_LISTENER_ENABLED=true
BRIDGE_EVENT_POLL_INTERVAL_MS=15000
BRIDGE_VALIDATOR_THRESHOLD_PERCENTAGE=67
BRIDGE_QUEUE_PROCESS_INTERVAL_MS=5000
```

### 4. Start the Service

The bridge service starts automatically when `BRIDGE_EVENT_LISTENER_ENABLED=true`.

```bash
npm run dev
```

## API Endpoints

### Chain Management

- `GET /api/v1/bridge/chains` - List all bridge chains
- `POST /api/v1/bridge/chains` - Create a new bridge chain

### Validator Management

- `GET /api/v1/bridge/validators` - List all validators
- `POST /api/v1/bridge/validators` - Add a new validator

### Event Monitoring

- `GET /api/v1/bridge/events` - List bridge events (with filters)
- `POST /api/v1/bridge/events/:id/sign` - Submit validator signature

### Queue Management

- `GET /api/v1/bridge/operations` - List queued operations
- `GET /api/v1/bridge/queue/stats` - Get queue statistics
- `POST /api/v1/bridge/queue/retry` - Retry failed operations

### Simulation

- `POST /api/v1/bridge/simulate` - Simulate mint transaction

## Workflow

1. **Event Detection**: The event listener polls configured EVM chains for `TokensLocked`, `TokensReleased`, and `TokensBurned` events from bridge contracts.

2. **Event Recording**: Detected events are stored in the `BridgeEvent` table with status `PENDING`.

3. **Signature Collection**: Validators submit signatures via the API endpoint. Each signature is verified against the event data.

4. **Threshold Verification**: Once the signature threshold (default 2/3 of total weight) is met, the event status changes to `VERIFIED`.

5. **Transaction Staging**: A Soroban mint transaction is staged using the verified event data.

6. **Queue Processing**: The mint operation is enqueued in the PostgreSQL queue with priority.

7. **Transaction Submission**: The queue processor submits the staged transaction to Soroban.

8. **Completion**: Upon successful confirmation, both the operation and event are marked as `COMPLETED`.

## Security Considerations

- **Validator Threshold**: Uses weighted signature verification (configurable threshold)
- **Signature Verification**: Supports both ECDSA (EVM) and Ed25519 (Stellar) signatures
- **Duplicate Prevention**: Prevents multiple signatures from same validator
- **Transaction Simulation**: Pre-flight checks before submission
- **Retry Logic**: Automatic retry with exponential backoff for failed operations

## Monitoring

The service includes comprehensive logging:

- Event detection and processing
- Signature verification results
- Transaction staging and submission
- Queue processing statistics
- Error tracking and alerts

## Troubleshooting

### Service Not Starting

- Check `BRIDGE_EVENT_LISTENER_ENABLED=true` in `.env`
- Verify `DATABASE_URL` is configured
- Ensure bridge chains are configured in database

### Events Not Being Detected

- Verify RPC endpoints are accessible
- Check bridge contract addresses are correct
- Ensure chain is marked as `isActive: true`
- Check logs for RPC connection errors

### Signature Verification Failing

- Verify validator addresses are correct
- Check signature format (hex-encoded)
- Ensure message construction matches signing
- Review validator weights and threshold

### Transactions Not Submitting

- Check Soroban contract ID is configured
- Verify Stellar secret key is set
- Ensure sufficient XLM balance for fees
- Review transaction simulation results

## Development

### Adding New Chains

1. Add chain configuration via API or database
2. Configure RPC endpoint and bridge contract
3. Add validators with appropriate weights
4. Service will automatically start polling

### Custom Event Types

Extend the `parseLog` method in `bridgeEventListener.ts` to support additional event signatures and parsing logic.

### Modifying Threshold

Update `BRIDGE_VALIDATOR_THRESHOLD_PERCENTAGE` in `.env` or modify the verification logic in `bridgeSignatureVerification.ts`.

## Production Considerations

- Use secure RPC endpoints (preferably private nodes)
- Implement proper key management for validator keys
- Set appropriate polling intervals to balance latency and load
- Monitor queue depth and processing times
- Implement alerting for failed operations
- Regular cleanup of old completed operations
- Backup bridge configuration and event history
