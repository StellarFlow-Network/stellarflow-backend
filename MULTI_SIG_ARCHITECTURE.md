# Multi-Sig Architecture & Optimization Summary

## Overview

This document provides a technical overview of the multi-sig implementation and the architectural optimizations made to the StellarFlow backend for supporting multi-signature price updates.

## Architecture Improvements

### 1. Separation of Concerns

**Before:**
- Single StellarService handling all transaction submission
- Direct submission without intermediate approval layer
- No separation between signing and submission

**After:**
- **MultiSigService**: Handles signature collection and aggregation
- **MultiSigSubmissionService**: Background job for approval → submission
- **StellarService**: Enhanced with multi-sig support while maintaining single-sig capabilities
- **MarketRateService**: Orchestrates price flow based on configuration

### 2. Asynchronous Signature Collection

**Key Optimization:**
```typescript
// Non-blocking signature requests
private async requestRemoteSignaturesAsync(
  multiSigPriceId: number,
  memoId: string
): Promise<void>
```

**Benefits:**
- Price fetches complete immediately (not blocked waiting for remote signatures)
- Signatures collected in parallel via `Promise.allSettled()`
- Failures on one server don't affect others
- Background job handles eventual submission

### 3. Database Schema for Audit Trail

**New Models:**
```
MultiSigPrice (tracks approval state)
  ↓
MultiSigSignature (individual signer records)
  
Links to existing:
- PriceReviewService records (for approval history)
- OnChainPrice records (for confirmation)
```

**Audit Benefits:**
- Complete signature history retained
- Signer identity recorded (public key + name)
- Timestamp for each signature
- Expiration tracking

### 4. Network Communication Pattern

**Server-to-Server Communication:**
```
Server A (Primary)
  ├─ Fetches rate
  ├─ Creates multi-sig request
  ├─ Signs locally
  └─ Sends request to Server B
       ↓
Server B (Secondary)
  ├─ Validates authorization token
  ├─ Signs with own key
  └─ Returns signature
       ↓
Server A
  ├─ Records remote signature
  ├─ Aggregates all signatures
  ├─ Builds multi-sig transaction
  └─ Submits to Stellar
```

**Optimizations:**
- HTTP endpoints for synchronous signing requests
- Authorization via shared token
- Deterministic message format ensures signature compatibility
- Public key-based signer identification

## Soroban Contract Interaction Optimization

### 1. Multi-Sig Transaction Construction

**Before:** Single signature per transaction
```
Transaction
├─ Operations: ManageData (price update)
├─ Memo: SF-NGN-1234567890
└─ Signature: [local-key]
```

**After:** Multiple signatures from different servers
```
Transaction
├─ Operations: ManageData (price update)
├─ Memo: SF-NGN-1234567890
└─ Signatures: [
    { hint, signature },  // Server 1
    { hint, signature }   // Server 2
  ]
```

**Benefits:**
- Soroban contract can verify multiple signatures
- Authorizes price updates only when multiple signers agree
- Prevents single server compromise
- Threshold-based verification (default: 2-of-2)

### 2. Signature Aggregation Method

```typescript
submitMultiSignedPriceUpdate(
  currency: string,
  price: number,
  memoId: string,
  signatures: Array<{ signerPublicKey, signature }>
): Promise<string>
```

**Process:**
1. Build transaction (single sequence account)
2. Sign with local keypair
3. Convert to XDR envelope
4. Add remote signatures using `addSignatureToEnvelope()`
5. Verify each signature has valid hint from public key
6. Submit combined envelope

### 3. Fee Optimization for Multi-Sig

**Current Implementation:**
- Uses median fee (p50) from Horizon fee_stats
- Applies fee increment multiplier on retry: 50% per attempt
- Configurable retry limit (default: 3)

**Multi-Sig Consideration:**
- Fee calculated per attempt (accounts for all signatures)
- Fixed fee amount doesn't change with signature count
- Stellar charges per operation, not per signature

## Performance Characteristics

### Time Complexity

**Single Signature:**
```
Fetch (~100ms) → Review (instant) → Sign (instant) → Submit (~2s) = ~2.1s
```

**Multi-Signature:**
```
Fetch (~100ms) → Review (instant) → Sign (instant) + Request Remote (~500ms-5s)
    ↓ (async, non-blocking)
    Background job polls every 30s
    ↓
Submit (~2s) = ~2.6s average (if remote responds quickly)
```

**Key Point:** Price fetch returns immediately in both cases; submission happens async.

### Space Complexity

**Database:**
- MultiSigPrice: ~500 bytes per record
- MultiSigSignature: ~1KB per signature
- Low space impact: signature aggregation is temporary

**Network:**
- Multi-sig doesn't increase transaction size significantly
- Envelope signatures are compact (64 bytes each)
- Stellar network handles multi-sig natively

## Configuration Flexibility

### Mode 1: Legacy Single-Signature
```bash
# Default behavior - prices submitted immediately
MULTI_SIG_ENABLED=false
```

### Mode 2: Multi-Signature with 2 Servers
```bash
MULTI_SIG_ENABLED=true
MULTI_SIG_REQUIRED_COUNT=2
REMOTE_ORACLE_SERVERS=http://oracle-2.internal:3000
```

### Mode 3: Multi-Signature with 3+ Servers
```bash
MULTI_SIG_ENABLED=true
MULTI_SIG_REQUIRED_COUNT=3
REMOTE_ORACLE_SERVERS=http://oracle-2.internal:3000,http://oracle-3.internal:3000,http://oracle-4.internal:3000
```

## Error Handling & Resilience

### Signature Request Failures

**Scenario:** Remote server is down
```
Action: Request fails silently (logged as warning)
Result: MultiSigPrice waits for timeout (1 hour)
After:  Cleaned up as EXPIRED
```

**Behavior:** Doesn't block price fetching or other signatures

### Partial Signatures

**Scenario:** 1 of 2 signatures collected before expiration
```
Action: MultiSigPrice remains PENDING
Result: Background job skips (not APPROVED)
After:  Cleaned up as EXPIRED after 1 hour
```

**Retry:** Next price update initiates fresh multi-sig flow

### Stellar Submission Failures

**Scenario:** Multi-sig transaction fails fee validation
```
Action: StellarService retries with 50% fee increase (up to 3x)
Result: Eventually succeeds or throws after max retries
```

**Behavior:** Background job marks as failed, continues with next price

## Security Considerations

### 1. Signature Determinism

Using deterministic message format ensures:
```
All servers sign identical message:
  "SF-PRICE-NGN-1234.56-CoinGecko"
```

Any difference (rate, currency, source) results in incompatible signatures.

### 2. Public Key Validation

```typescript
// Each signature has a "hint" derived from signer's public key
Keypair.fromPublicKey(signerPublicKey).signatureHint()
```

Stellar network verifies each signature matches its public key.

### 3. Network Security

Recommendations for production:
- Use HTTPS for all server-to-server communication
- Implement VPN or private network for inter-server calls
- Use short-lived authorization tokens
- Implement request signing for additional security

### 4. Expiration & Replay

- 1-hour window prevents old signatures from being reused
- New memo ID per price request prevents confusion
- Background cleanup removes expired records

## Monitoring & Observability

### Key Metrics

1. **Multi-Sig Request Latency**
   - Time from request creation to approval
   - Target: < 5 seconds (local sign + 1 remote sign)

2. **Signature Collection Rate**
   - % of prices successfully collecting all signatures
   - Target: > 95%

3. **Submission Success Rate**
   - % of approved prices successfully submitted to Stellar
   - Target: 100%

4. **Queue Depth**
   - Number of PENDING multi-sig prices
   - Should remain low (< 10)

### Logging

Service includes detailed logging at each step:
```
[MultiSig] Created signature request 123 for NGN rate 1234.56
[MultiSig] Added signature 1/2 for MultiSigPrice 123
[MultiSig] Multi-Sig price 123 is now APPROVED
[MultiSigSubmissionService] Successfully submitted multi-sig price 123
```

## Testing Strategy

### Unit Tests
- MultiSigService signature aggregation
- Message format determinism
- Expiration logic

### Integration Tests
- Server-to-server communication
- Multi-sig transaction submission
- Error recovery scenarios

### Load Tests
- Concurrent price updates
- Remote server latency impact
- Signature queue handling

## Deployment Checklist

- [ ] Update `.env` with MULTI_SIG_* variables
- [ ] Run `prisma migrate` to create new tables
- [ ] Update all oracle servers with same MULTI_SIG_AUTH_TOKEN
- [ ] Configure REMOTE_ORACLE_SERVERS on each server
- [ ] Restart backend services
- [ ] Verify multi-sig endpoints in health check
- [ ] Monitor logs during initial operation
- [ ] Test manual price submission via endpoints

## Backward Compatibility

✅ **Fully Compatible**
- Existing single-sig code continues to work
- Feature gates based on `MULTI_SIG_ENABLED` env var
- No breaking changes to existing APIs
- Can run multi-sig and single-sig instances side-by-side

## Future Optimizations

### 1. Signature Caching
Pre-fetch and cache recent signatures to reduce latency

### 2. Weighted Voting
Support 2-of-3 or other threshold combinations

### 3. Parallel Submission
Submit approved prices in batches

### 4. WebSocket Updates
Real-time multi-sig status via Socket.io

### 5. Distributed Consensus
Byzantine Fault Tolerance for > 2 signers
