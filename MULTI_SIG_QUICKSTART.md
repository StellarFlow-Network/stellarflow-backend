# Multi-Sig Quick Start Guide

## 5-Minute Setup for 2-Server Multi-Sig

### Prerequisites
- 2 StellarFlow backend instances running
- Both connected to same database
- Stellar TESTNET accounts set up

### Step 1: Generate Shared Token
```bash
# Generate a random token (or use your own)
openssl rand -hex 32
# Output: a3f8e2d4c6b1f9e7a5d3c2b8f0e9d4c6
```

### Step 2: Update Server 1 (.env)
```bash
# Price Update Configuration
MULTI_SIG_ENABLED=true
MULTI_SIG_REQUIRED_COUNT=2
REMOTE_ORACLE_SERVERS=http://server2.internal:3000
MULTI_SIG_AUTH_TOKEN=a3f8e2d4c6b1f9e7a5d3c2b8f0e9d4c6
ORACLE_SIGNER_NAME=oracle-primary
MULTI_SIG_POLL_INTERVAL_MS=30000
```

### Step 3: Update Server 2 (.env)
```bash
# Price Update Configuration
MULTI_SIG_ENABLED=true
MULTI_SIG_REQUIRED_COUNT=2
REMOTE_ORACLE_SERVERS=http://server1.internal:3000
MULTI_SIG_AUTH_TOKEN=a3f8e2d4c6b1f9e7a5d3c2b8f0e9d4c6
ORACLE_SIGNER_NAME=oracle-secondary
MULTI_SIG_POLL_INTERVAL_MS=30000
```

### Step 4: Run Migrations
On each server:
```bash
npm run db:migrate
```

This creates the new tables:
- `MultiSigPrice`
- `MultiSigSignature`

### Step 5: Restart Services
```bash
# Server 1
npm run start  # or: npm run dev

# Server 2 (separate terminal/host)
npm run start  # or: npm run dev
```

Watch logs for:
```
[MarketRateService] Multi-Sig mode ENABLED with 1 remote servers
[MultiSigSubmissionService] Started with 30000ms poll interval
🔐 Multi-Sig submission service started
```

## Testing Multi-Sig

### Manual Test: Request a Price
```bash
# Request NGN price (will trigger multi-sig flow)
curl http://localhost:3000/api/market-rates/rate/NGN

# Response includes new fields:
{
  "success": true,
  "data": {
    "currency": "NGN",
    "rate": 1234.56,
    "source": "CoinGecko",
    "pendingMultiSig": true,
    "multiSigPriceId": 123,
    ...
  }
}
```

### Check Pending Multi-Sig Prices
```bash
curl http://localhost:3000/api/price-updates/multi-sig/pending

# Response:
{
  "success": true,
  "data": [
    {
      "id": 123,
      "currency": "NGN",
      "rate": 1234.56,
      "status": "PENDING",
      "collectedSignatures": 1,  // local sign done
      "requiredSignatures": 2,
      "expiresAt": "2024-03-27T16:30:00Z"
    }
  ]
}
```

### Monitor Status Until Approval
```bash
# Check status of price #123
curl http://localhost:3000/api/price-updates/multi-sig/123/status

# Watch for status to change from PENDING → APPROVED
# Should happen within seconds if servers communicate properly
```

### Verify Multi-Sig Submission
```bash
# Once APPROVED, check if signatures are ready
curl http://localhost:3000/api/price-updates/multi-sig/123/signatures

# Response shows all signatures
{
  "success": true,
  "data": {
    "multiSigPriceId": 123,
    "signatures": [
      {
        "signerPublicKey": "GXXXXXX1",
        "signerName": "oracle-primary",
        "signature": "3c5a7d2..."
      },
      {
        "signerPublicKey": "GXXXXXX2",
        "signerName": "oracle-secondary",
        "signature": "8e1f4b9..."
      }
    ]
  }
}
```

### Check Stellar Submission
```bash
# After background job submits to Stellar (check OnChainPrice table)
# Price should appear in market rates with stellarTxHash set

SELECT * FROM "OnChainPrice" 
WHERE currency = 'NGN' 
ORDER BY "confirmedAt" DESC 
LIMIT 1;

# Should see the multi-signed transaction
```

## Troubleshooting

### Issue: Multi-Sig requests not being signed

**Check 1: Is multi-sig enabled on both servers?**
```bash
# Server logs should show:
[MarketRateService] Multi-Sig mode ENABLED with 1 remote servers
```

**Check 2: Can servers reach each other?**
```bash
# From Server 1, test connectivity to Server 2:
curl http://server2.internal:3000/api/price-updates/multi-sig/signer-info

# Should return server 2's public key
```

**Check 3: Is auth token correct?**
```bash
# Check error in logs:
[API] Signature creation failed: Unauthorized - invalid token

# Ensure MULTI_SIG_AUTH_TOKEN matches on both servers
```

### Issue: Signatures stuck at 1/2

**Check database:**
```bash
SELECT * FROM "MultiSigSignature" WHERE "multiSigPriceId" = 123;

# Should show 2 rows (one per server)
# If only 1 row, remote signature request failed
```

**Check logs for:**
```
[MarketRateService] ⚠️ Signature request failed for http://server2.internal:3000
[MarketRateService] ❌ Error requesting signature from http://server2.internal:3000
```

### Issue: Background job not submitting approved prices

**Check 1: Is submission service running?**
```bash
# Logs should show:
[MultiSigSubmissionService] Started with 30000ms poll interval
```

**Check 2: Are there approved prices?**
```bash
SELECT * FROM "MultiSigPrice" WHERE status = 'APPROVED';

# If empty, prices haven't been approved yet
# If exists, check if background job has errors in logs
```

**Check 3: Stellar submission failures**
```
[MultiSigSubmissionService] Failed to submit multi-sig price 123: ...

# Check network connectivity and account balance
```

## Switching Modes

### Enable Multi-Sig (from single-sig)
1. Update `.env` with `MULTI_SIG_ENABLED=true`
2. Configure `REMOTE_ORACLE_SERVERS`
3. Run `prisma migrate`
4. Restart services
5. New prices will use multi-sig flow

### Disable Multi-Sig (revert to single-sig)
1. Update `.env` with `MULTI_SIG_ENABLED=false`
2. Restart services
3. Existing pending multi-sig prices won't be submitted
4. New prices will use direct submission

## Production Readiness

Before deploying to production:

- [ ] Use HTTPS for all server-to-server communication
- [ ] Implement rate limiting on signature endpoints
- [ ] Set up monitoring and alerting for:
  - Pending multi-sig prices (should be low)
  - Remote signature request failures
  - Submission delays
- [ ] Test failover scenarios:
  - Server down
  - Network latency
  - Stellar network congestion
- [ ] Document runbooks for common issues
- [ ] Schedule regular security audits
- [ ] Implement logging to centralized aggregation service

## Support

For issues, check:
1. `/workspaces/stellarflow-backend/MULTI_SIG_GUIDE.md` - Comprehensive guide
2. `/workspaces/stellarflow-backend/MULTI_SIG_ARCHITECTURE.md` - Technical details
3. Application logs - Most issues visible in detailed logs
4. Database tables - Inspect MultiSigPrice/MultiSigSignature records directly
