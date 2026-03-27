# Multi-Sig Implementation Guide

## Overview

This document describes the multi-sig (multi-signature) implementation for StellarFlow that allows two or more oracle servers to collectively sign and approve price updates before they are submitted to the Soroban contract on Stellar.

## Architecture

### Components

1. **MultiSigService** (`src/services/multiSigService.ts`)
   - Manages multi-sig price requests
   - Handles signature collection and aggregation
   - Communicates with remote servers for signature requests
   - Tracks signature expiration

2. **MultiSigSubmissionService** (`src/services/multiSigSubmissionService.ts`)
   - Background job that polls for approved multi-sig prices
   - Automatically submits approved prices to Stellar
   - Handles retries and error logging

3. **MarketRateService** (`src/services/marketRate/marketRateService.ts`)
   - Enhanced to support multi-sig workflow
   - Routes prices through multi-sig process when enabled
   - Asynchronously requests remote signatures

4. **StellarService** (`src/services/stellarService.ts`)
   - New method: `submitMultiSignedPriceUpdate()`
   - Combines multiple signatures into a single Stellar transaction
   - Handles fee bumping and retries for multi-signed transactions

5. **PriceUpdates Routes** (`src/routes/priceUpdates.ts`)
   - API endpoints for multi-sig operations
   - Remote signature request endpoint: `POST /api/price-updates/sign`
   - Status monitoring endpoints

### Database Schema

Three new models added to `prisma/schema.prisma`:

- **MultiSigPrice**: Tracks multi-sig price approval requests
  - Stores currency, rate, required/collected signatures
  - Tracks expiration and submission status
  
- **MultiSigSignature**: Individual signatures from signers
  - Records signer identity and timestamp
  - Stores signature in hex format

- **MultiSigPrice Relationship**: Links to price review records for audit trail

## Configuration

### Environment Variables

Add the following to your `.env` file to enable multi-sig:

```bash
# Enable multi-signature mode (required to activate feature)
MULTI_SIG_ENABLED=true

# Number of signatures required before submission (default: 2)
MULTI_SIG_REQUIRED_COUNT=2

# Comma-separated list of remote oracle server URLs
# These servers will be requested to sign price updates
REMOTE_ORACLE_SERVERS=http://oracle-2.example.com:3000,http://oracle-3.example.com:3000

# Authentication token for remote signature requests
# All servers should use the same token for inter-server communication
MULTI_SIG_AUTH_TOKEN=your-secure-auth-token

# Polling interval for multi-sig submission service (milliseconds)
# How often to check for approved prices to submit
MULTI_SIG_POLL_INTERVAL_MS=30000

# Name/identifier for this oracle server
# Used in signature records for tracking
ORACLE_SIGNER_NAME=oracle-server-1
```

### Example Multi-Server Setup

**Server 1 (Primary):**
```bash
ORACLE_SECRET_KEY=SBXXX...
MULTI_SIG_ENABLED=true
MULTI_SIG_REQUIRED_COUNT=2
REMOTE_ORACLE_SERVERS=http://server2.internal:3000
MULTI_SIG_AUTH_TOKEN=shared-secret-token
ORACLE_SIGNER_NAME=oracle-primary
```

**Server 2 (Secondary):**
```bash
ORACLE_SECRET_KEY=SBYYY...
MULTI_SIG_ENABLED=true
MULTI_SIG_REQUIRED_COUNT=2
REMOTE_ORACLE_SERVERS=http://server1.internal:3000
MULTI_SIG_AUTH_TOKEN=shared-secret-token
ORACLE_SIGNER_NAME=oracle-secondary
```

## Workflow

### Price Update Flow with Multi-Sig

```
1. Price Fetched
   ↓
2. Price Reviewed (anomaly detection)
   ↓
3. If AUTO_APPROVED:
   ├─ Multi-Sig Request Created
   ├─ Local Server Signs
   └─ Remote Signatures Requested (async)
   ↓
4. Remote Servers Receive Request via:
   POST /api/price-updates/sign
   ↓
5. Remote Servers Sign and Return Signature
   ↓
6. Once All Signatures Collected:
   ├─ MultiSigPrice marked as APPROVED
   ├─ Background job detects APPROVED status
   └─ Multiple Signatures Added to Transaction
   ↓
7. Transaction Submitted to Stellar
   ↓
8. Confirmation Recorded
```

### Detailed Steps

#### Step 1: Price Assessment
- MarketRateService fetches rate
- PriceReviewService evaluates for anomalies
- If manual review needed → PENDING
- If approved → proceed to multi-sig

#### Step 2: Multi-Sig Request Creation
- MultiSigService creates MultiSigPrice record
- Sets required signature count (default: 2)
- Sets expiration time (1 hour)

#### Step 3: Local Signing
- Local server immediately signs the price update
- Signature stored in MultiSigSignature table
- Collected signatures incremented

#### Step 4: Remote Signature Requests (Async)
```javascript
// Non-blocking request to remote servers
// Each remote server independently signs
POST /api/price-updates/sign
{
  "multiSigPriceId": 123,
  "currency": "NGN",
  "rate": 1234.56,
  "source": "CoinGecko",
  "memoId": "SF-NGN-1234567890",
  "signerPublicKey": "GXXXXXX..."
}
```

#### Step 5: Signature Aggregation
- Remote servers receive request on their `/api/price-updates/sign` endpoint
- They verify authorization token
- They sign the price data (deterministic message format)
- They return signature
- Requesting server records remote signature

#### Step 6: Approval & Submission
- Once all signatures collected → MultiSigPrice.status = "APPROVED"
- MultiSigSubmissionService polls for APPROVED prices
- All signatures added to Stellar transaction
- Transaction submitted with multiple signatures

#### Step 7: Confirmation
- After confirmation on Stellar:
  - MultiSigPrice.submittedAt set
  - Linked PriceReviewService record marked as SUBMITTED
  - OnChainPrice record created

## API Endpoints

### Create Multi-Sig Request
```http
POST /api/price-updates/multi-sig/request
Content-Type: application/json

{
  "priceReviewId": 123,
  "currency": "NGN",
  "rate": 1234.56,
  "source": "CoinGecko",
  "memoId": "SF-NGN-1234567890"
}

Response:
{
  "success": true,
  "data": {
    "multiSigPriceId": 456,
    "currency": "NGN",
    "rate": 1234.56,
    "requiredSignatures": 2
  }
}
```

### Submit Signature (Remote Server)
```http
POST /api/price-updates/sign
Authorization: Bearer your-secure-auth-token
Content-Type: application/json

{
  "multiSigPriceId": 456,
  "currency": "NGN",
  "rate": 1234.56,
  "source": "CoinGecko",
  "memoId": "SF-NGN-1234567890",
  "signerPublicKey": "GXXXXXX..."
}

Response:
{
  "success": true,
  "data": {
    "multiSigPriceId": 456,
    "signature": "hex_encoded_signature",
    "signerPublicKey": "GXXXXXX...",
    "signerName": "oracle-secondary"
  }
}
```

### Get Multi-Sig Status
```http
GET /api/price-updates/multi-sig/456/status

Response:
{
  "success": true,
  "data": {
    "id": 456,
    "currency": "NGN",
    "rate": 1234.56,
    "status": "APPROVED",
    "collectedSignatures": 2,
    "requiredSignatures": 2,
    "expiresAt": "2024-03-27T16:30:00Z",
    "signers": [
      {
        "publicKey": "GXXXXXX...",
        "name": "oracle-primary",
        "signedAt": "2024-03-27T15:30:00Z"
      },
      {
        "publicKey": "GYYYYYYY...",
        "name": "oracle-secondary",
        "signedAt": "2024-03-27T15:30:05Z"
      }
    ]
  }
}
```

### Get Signed Transaction (After Approval)
```http
GET /api/price-updates/multi-sig/456/signatures

Response:
{
  "success": true,
  "data": {
    "multiSigPriceId": 456,
    "currency": "NGN",
    "rate": 1234.56,
    "signatures": [
      {
        "signerPublicKey": "GXXXXXX...",
        "signerName": "oracle-primary",
        "signature": "hex_encoded_signature_1"
      },
      {
        "signerPublicKey": "GYYYYYYY...",
        "signerName": "oracle-secondary",
        "signature": "hex_encoded_signature_2"
      }
    ]
  }
}
```

### Get Signer Info
```http
GET /api/price-updates/multi-sig/signer-info

Response:
{
  "success": true,
  "data": {
    "publicKey": "GXXXXXX...",
    "name": "oracle-primary"
  }
}
```

### List Pending Multi-Sig Prices
```http
GET /api/price-updates/multi-sig/pending

Response:
{
  "success": true,
  "data": [
    {
      "id": 456,
      "currency": "NGN",
      "rate": 1234.56,
      "status": "PENDING",
      "collectedSignatures": 1,
      "requiredSignatures": 2,
      "expiresAt": "2024-03-27T16:30:00Z",
      "signerCount": 1
    }
  ]
}
```

### Record Submission
```http
POST /api/price-updates/multi-sig/456/record-submission
Content-Type: application/json

{
  "memoId": "SF-NGN-1234567890",
  "stellarTxHash": "abc123def456..."
}

Response:
{
  "success": true
}
```

## Security Considerations

### 1. Authentication
- All inter-server communication requires `MULTI_SIG_AUTH_TOKEN`
- Implement HTTPS in production for all server-to-server calls
- Use unique token per deployment environment

### 2. Signature Verification
- Deterministic message format ensures all servers sign same data
- Format: `SF-PRICE-<CURRENCY>-<RATE>-<SOURCE>`
- Public keys verified on Stellar network

### 3. Expiration
- Multi-sig requests expire after 1 hour by default
- Prevents old signatures from being used
- Background cleanup job removes expired records

### 4. Rate Limiting
- Consider implementing rate limiting on `POST /api/price-updates/sign`
- Prevents signature endpoint from being abused

## Fallback Modes

### Disabling Multi-Sig
Set `MULTI_SIG_ENABLED=false` to revert to single-signature mode:
- Prices submitted immediately after approval
- No remote signature requests
- Direct submission to Stellar

### Legacy Compatibility
- Code maintains backward compatibility
- Existing single-sig endpoints still function
- Can use multi-sig URLs even if disabled (returns appropriate errors)

## Monitoring & Debugging

### Check Multi-Sig Service Status
Monitor logs for:
```
[MultiSig] Created signature request 123 for NGN rate 1234.56
[MultiSig] Added signature 2/2 for MultiSigPrice 123
[MultiSig] MultiSigPrice 123 is now APPROVED
[MultiSigSubmissionService] Successfully submitted multi-sig price 123
```

### Database Queries

Find pending multi-sig prices:
```sql
SELECT * FROM "MultiSigPrice" WHERE status = 'PENDING';
```

Check signatures for a price:
```sql
SELECT * FROM "MultiSigSignature" WHERE "multiSigPriceId" = 123;
```

Find expired requests:
```sql
SELECT * FROM "MultiSigPrice" 
WHERE status = 'PENDING' AND "expiresAt" < NOW();
```

### Common Issues

**Issue: Remote signature requests failing**
- Verify `REMOTE_ORACLE_SERVERS` URLs are correct
- Check `MULTI_SIG_AUTH_TOKEN` matches on all servers
- Ensure network connectivity between servers
- Check firewall rules allow inter-server communication

**Issue: Signatures not being collected**
- Verify remote server's `/api/price-updates/sign` endpoint is working
- Check logs for "Failed to request signature from..."
- Ensure `MULTI_SIG_ENABLED=true` on remote server

**Issue: Prices stuck in PENDING status**
- Check if required signature count is too high
- Verify all remote servers are running and healthy
- Check expiration times

## Performance Tuning

### Polling Interval
```bash
# Check for approved prices every 10 seconds (faster)
MULTI_SIG_POLL_INTERVAL_MS=10000

# Check every 60 seconds (slower, less resource usage)
MULTI_SIG_POLL_INTERVAL_MS=60000
```

### Signature Expiration
Current: 1 hour (3600000 ms)
Adjust in `MultiSigService` constructor if needed

### Database Indexes
All multi-sig tables have appropriate indexes:
- `multiSigPrice(status, expiresAt)`
- `multiSigSignature(multiSigPriceId)`

## Future Enhancements

1. **Variable Signature Thresholds**
   - Support weighted voting (e.g., 2-of-3)
   - Different thresholds per currency

2. **Distributed Consensus**
   - Byzantine Fault Tolerance
   - Timeout handling for non-responsive servers

3. **Signature Caching**
   - Pre-sign common price updates
   - Reduce round-trip time

4. **WebSocket Updates**
   - Real-time multi-sig status via Socket.io
   - Dashboard integration

5. **Audit Trail**
   - More detailed logging of signature process
   - Compliance reporting
