# Price Sanity Check System

## Overview

The Price Sanity Check System automatically compares Oracle prices with external sources (CoinGecko, ExchangeRate-API) to detect significant deviations and alert admins when prices differ by more than 2%.

## Features

- ✅ Automatic price comparison with external sources
- ✅ 2% deviation threshold for alerts
- ✅ Multiple external data sources for redundancy
- ✅ Webhook alerts to Discord/Slack
- ✅ Detailed logging of all checks
- ✅ Manual check endpoints for monitoring
- ✅ Non-blocking integration (doesn't stop price updates)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Price Fetch Flow                          │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Fetch Price from Sources                        │
│              (NGN, KES, GHS Fetchers)                        │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Price Review Assessment                         │
│              (Check for anomalies)                           │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              🔍 SANITY CHECK                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  1. Fetch price from CoinGecko                         │ │
│  │  2. Fetch price from ExchangeRate-API                  │ │
│  │  3. Calculate deviation percentage                     │ │
│  │  4. Compare with 2% threshold                          │ │
│  │  5. Log warning if exceeded                            │ │
│  │  6. Send webhook alert to admins                       │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              Submit to Stellar Network                       │
│              (Continue regardless of sanity check)           │
└─────────────────────────────────────────────────────────────┘
```

## How It Works

### 1. Automatic Checks

Every time a price is fetched and passes review, the sanity check service:

1. **Fetches external price** from CoinGecko or ExchangeRate-API
2. **Calculates deviation** between Oracle price and external price
3. **Compares with threshold** (2%)
4. **Logs warning** if deviation exceeds threshold
5. **Sends webhook alert** to configured Discord/Slack channels

### 2. External Sources

The service tries multiple sources in order:

1. **CoinGecko Direct** - Direct XLM/[Currency] pair
2. **ExchangeRate-API** - XLM/USD × USD/[Currency]

If one source fails, it automatically tries the next.

### 3. Deviation Calculation

```typescript
deviation = |oraclePrice - externalPrice| / externalPrice × 100
```

Example:

- Oracle Price: 150 NGN
- External Price: 147 NGN
- Deviation: |150 - 147| / 147 × 100 = 2.04%
- Result: ⚠️ Alert triggered (exceeds 2% threshold)

## Configuration

### Threshold

The deviation threshold is set to **2%** by default. This can be adjusted in:

```typescript
// src/services/sanityCheckService.ts
private readonly DEVIATION_THRESHOLD = 2.0; // 2% threshold
```

### Webhook Alerts

Alerts are sent via the webhook reporter. Configure in `.env`:

```bash
# Discord webhook URL for critical alerts (primary)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Slack webhook URL for critical alerts (fallback)
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# Rate limit for webhook alerts (minutes)
WEBHOOK_RATE_LIMIT_MINUTES=5
```

## API Endpoints

### Check Single Currency

```bash
GET /api/v1/sanity-check/check/:currency
```

**Example:**

```bash
curl http://localhost:3000/api/v1/sanity-check/check/NGN
```

**Response:**

```json
{
  "success": true,
  "data": {
    "currency": "NGN",
    "oraclePrice": 150.5,
    "externalPrice": 148.2,
    "deviation": 2.3,
    "deviationPercent": 1.55,
    "passed": true,
    "source": "CoinGecko",
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

### Check All Currencies

```bash
GET /api/v1/sanity-check/check-all
```

**Response:**

```json
{
  "success": true,
  "summary": {
    "total": 3,
    "passed": 2,
    "failed": 1
  },
  "data": [
    {
      "currency": "NGN",
      "oraclePrice": 150.5,
      "externalPrice": 148.2,
      "deviationPercent": 1.55,
      "passed": true,
      "source": "CoinGecko"
    },
    {
      "currency": "KES",
      "oraclePrice": 15.2,
      "externalPrice": 15.5,
      "deviationPercent": 1.94,
      "passed": true,
      "source": "CoinGecko"
    },
    {
      "currency": "GHS",
      "oraclePrice": 1.8,
      "externalPrice": 1.75,
      "deviationPercent": 2.86,
      "passed": false,
      "source": "ExchangeRate-API"
    }
  ]
}
```

### Get Threshold

```bash
GET /api/v1/sanity-check/threshold
```

**Response:**

```json
{
  "success": true,
  "data": {
    "threshold": 2,
    "description": "Alerts are triggered when price deviation exceeds 2%"
  }
}
```

## Alert Format

When a sanity check fails, admins receive a webhook alert:

```
🚨 **Price Sanity Check Alert**

**Currency:** NGN
**Oracle Price:** 150.5000
**External Price (CoinGecko):** 147.0000
**Deviation:** 2.38% (Threshold: 2.0%)
**Difference:** 3.5000

The Oracle price differs significantly from the external source. Please review.
```

## Logging

All sanity checks are logged with appropriate levels:

### Success (Debug Level)

```
✅ Sanity check passed for NGN
{
  oraclePrice: 150.5,
  externalPrice: 148.2,
  deviationPercent: 1.55,
  source: "CoinGecko"
}
```

### Warning (Threshold Exceeded)

```
⚠️ SANITY CHECK FAILED: NGN price deviation exceeds 2%
{
  currency: "NGN",
  oraclePrice: 150.5,
  externalPrice: 147.0,
  deviationPercent: 2.38,
  threshold: 2.0,
  source: "CoinGecko"
}
```

### Error (All Sources Failed)

```
Unable to perform sanity check for NGN - all external sources failed
```

## Testing

Run sanity check tests:

```bash
npm run test:jest -- sanityCheck.test.ts
```

### Manual Testing

Test with realistic price:

```bash
curl http://localhost:3000/api/v1/sanity-check/check/NGN
```

Test all currencies:

```bash
curl http://localhost:3000/api/v1/sanity-check/check-all
```

## Integration

The sanity check is automatically integrated into the price fetching flow:

```typescript
// In MarketRateService.getRate()
if (!reviewAssessment.manualReviewRequired) {
  // Perform sanity check before submitting to Stellar
  try {
    await sanityCheckService.checkPrice(normalizedCurrency, rate.rate);
  } catch (sanityError) {
    console.warn(`Sanity check failed for ${normalizedCurrency}:`, sanityError);
    // Continue with submission even if sanity check fails
  }

  // Submit to Stellar...
}
```

## Non-Blocking Design

The sanity check is **non-blocking**:

- If external sources fail, the price update continues
- If the check times out, the price update continues
- Errors are logged but don't stop the Oracle

This ensures the Oracle remains operational even if external APIs are down.

## Best Practices

1. **Monitor webhook alerts** - Set up Discord/Slack notifications
2. **Review failed checks** - Investigate when deviation exceeds threshold
3. **Check logs regularly** - Look for patterns in warnings
4. **Test periodically** - Use manual check endpoints to verify system
5. **Adjust threshold if needed** - Based on market volatility

## Troubleshooting

### No alerts received

1. Check webhook configuration in `.env`
2. Verify webhook URLs are valid
3. Check webhook rate limiting
4. Review logs for webhook errors

### All external sources failing

1. Check internet connectivity
2. Verify API endpoints are accessible
3. Check for rate limiting from external APIs
4. Review timeout settings

### False positives

1. Review market conditions (high volatility)
2. Consider adjusting threshold
3. Check if external sources are accurate
4. Verify Oracle price calculation

## Future Enhancements

- [ ] Configurable threshold per currency
- [ ] Historical deviation tracking
- [ ] Dashboard visualization
- [ ] Multiple threshold levels (warning, critical)
- [ ] Automatic price correction suggestions
- [ ] Integration with more external sources
- [ ] Machine learning for anomaly detection

## Files Created

1. **`src/services/sanityCheckService.ts`** - Core sanity check service
2. **`src/routes/sanityCheck.ts`** - API endpoints
3. **`test/sanityCheck.test.ts`** - Integration tests
4. **`SANITY_CHECK.md`** - This documentation

## Summary

The Price Sanity Check System provides an additional layer of security and monitoring for the StellarFlow Oracle by:

- Automatically comparing prices with trusted external sources
- Alerting admins when significant deviations are detected
- Providing manual check endpoints for monitoring
- Operating in a non-blocking manner to ensure Oracle reliability

This helps prevent erroneous prices from being submitted to the Stellar network and gives admins visibility into price accuracy.
