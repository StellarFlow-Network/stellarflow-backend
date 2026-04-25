# Sanity Check - Quick Reference

## 🎯 Purpose

Automatically compare Oracle prices with external sources and alert admins when deviation exceeds **2%**.

## 🚀 Quick Start

The sanity check runs automatically on every price fetch. No configuration needed!

## 📊 Check Prices Manually

### Single Currency

```bash
curl http://localhost:3000/api/v1/sanity-check/check/NGN
```

### All Currencies

```bash
curl http://localhost:3000/api/v1/sanity-check/check-all
```

### Get Threshold

```bash
curl http://localhost:3000/api/v1/sanity-check/threshold
```

## 🔔 Alert Example

When deviation exceeds 2%, admins receive:

```
🚨 Price Sanity Check Alert

Currency: NGN
Oracle Price: 150.5000
External Price (CoinGecko): 147.0000
Deviation: 2.38% (Threshold: 2.0%)
Difference: 3.5000

The Oracle price differs significantly from the external source.
```

## 📝 Log Messages

### ✅ Pass

```
✅ Sanity check passed for NGN
deviationPercent: 1.55%
```

### ⚠️ Fail

```
⚠️ SANITY CHECK FAILED: NGN price deviation exceeds 2%
deviationPercent: 2.38%
```

## 🔧 Configuration

### Adjust Threshold

Edit `src/services/sanityCheckService.ts`:

```typescript
private readonly DEVIATION_THRESHOLD = 2.0; // Change this
```

### Configure Webhooks

Add to `.env`:

```bash
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

## 🧪 Testing

```bash
npm run test:jest -- sanityCheck.test.ts
```

## 📚 Full Documentation

See [SANITY_CHECK.md](./SANITY_CHECK.md) for complete documentation.

## 🔍 How It Works

1. Price fetched from Oracle sources
2. Sanity check compares with CoinGecko/ExchangeRate-API
3. If deviation > 2%, warning logged + webhook sent
4. Price submission continues (non-blocking)

## 🎯 Key Points

- ✅ Automatic on every price fetch
- ✅ Non-blocking (doesn't stop Oracle)
- ✅ Multiple external sources
- ✅ Webhook alerts to Discord/Slack
- ✅ 2% deviation threshold
- ✅ Manual check endpoints available
