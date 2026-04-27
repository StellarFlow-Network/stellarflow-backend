# Automatic Gas Top-up Alert

## Overview

The **Automatic Gas Top-up Alert** feature monitors the Admin wallet XLM balance to prevent running out of funds for transaction fees. When the balance drops below a configured threshold, a critical webhook alert is sent to Discord.

## How It Works

1. **Continuous Monitoring**: The `GasBalanceMonitorService` checks the admin wallet balance every 5 minutes (configurable).
2. **Threshold Detection**: If the balance falls below 20 XLM (default, configurable), an alert is triggered
3. **Alert Notification**: A critical webhook alert is sent to Discord
4. **Rate Limiting**: Alerts are rate-limited to a maximum of 1 per hour to prevent notification spam
5. **Persistence**: Alert timing survives process restarts, ensuring proper rate limiting across deployments
6. **Escalation**: After 3 consecutive balance check failures, a critical escalation alert is sent
7. **Status Tracking**: Current balance, failure count, and threshold are tracked for operational visibility

## Environment Variables

### Required

- **`SOROBAN_ADMIN_SECRET`** or **`ORACLE_SECRET_KEY`**
  - The secret key of the Admin wallet to monitor
  - Used to derive the public key for balance queries
  - Already required by other StellarFlow components

### Optional

- **`GAS_BALANCE_ALERT_THRESHOLD_XLM`**
  - Alert threshold in XLM (default: `20`)
  - Minimum balance before alert is triggered
  - Example: `GAS_BALANCE_ALERT_THRESHOLD_XLM=15` (alert when balance < 15 XLM)

- **`DEBUG`**
  - Enable debug logging for balance checks (logs every check, can be verbose)
  - Default: unset (only logs warnings/errors)

### Webhook Configuration

- **`DISCORD_WEBHOOK_URL`** (required)
  - Discord webhook URL for alerts
  - Example: `https://discord.com/api/webhooks/XXXXXXXXXXXXX/XXXXXXXXXXXXXXXXX`

## Configuration Example

```env
# Admin account to monitor
SOROBAN_ADMIN_SECRET=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Alert threshold (20 XLM default)
GAS_BALANCE_ALERT_THRESHOLD_XLM=20

# Webhook configuration (Discord only)
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/XXXXXXXXXXXXX/XXXXXXXXXXXXXXXXX
```

## Alert Types

### 1. Low Balance Alert

**Triggered when**: Admin wallet balance < configured threshold  
**Frequency**: Maximum 1 per hour (rate-limited)  
**Format**: Discord embed with red color

**Fields**:
- Current Balance (XLM)
- Alert Threshold (XLM)
- Deficit (how much below threshold)
- Action Required
- Timestamp

### 2. Monitor Failure Escalation Alert

**Triggered when**: 3 consecutive failed balance checks  
**Frequency**: Once per escalation cycle  
**Format**: Discord embed with red color

**Indicates**:
- Unable to reach Stellar Horizon
- Environment variable misconfiguration
- Network connectivity issues

**Fields**:
- Consecutive Failures count
- Last Known Balance
- Issue Description
- Required Action (investigate connectivity)
- Timestamp

## Service Status

Check the health endpoint or monitor logs for:

```
[GasBalanceMonitor] Started with 300000ms check interval (threshold: 20 XLM)
⛽ Gas balance monitor service started
```

To get current service status:

```bash
# From Node.js environment
const { getGasBalanceMonitorService } = require('./src/services/gasBalanceMonitorService');
const monitor = getGasBalanceMonitorService();
console.log(monitor.getStatus());
```

Output:
```json
{
  "isRunning": true,
  "checkIntervalMs": 300000,
  "balanceThresholdXLM": 20,
  "lastKnownBalance": 25.5,
  "consecutiveFailures": 0
}
```

## Monitoring and Troubleshooting

### Startup Verification

Look for these log messages on application start:

```
⛽ Gas balance monitor service started
[GasBalanceMonitor] Started with 300000ms check interval (threshold: 20 XLM)
```

### Checking Balance

To manually check the admin wallet balance:

```bash
npm run check:gas-balance
```

### Alert Won't Send

1. Verify `DISCORD_WEBHOOK_URL` is set correctly
2. Verify network connectivity to Discord API
3. Check logs for webhook errors
4. Test webhook with curl to verify it's working

### Monitor Escalation Alert Triggered

If you see "CRITICAL: Gas Monitor Failures", the balance check has failed 3+ times:

1. Check Stellar Horizon connectivity (TESTNET or MAINNET based on your config)
2. Verify `SOROBAN_ADMIN_SECRET` or `ORACLE_SECRET_KEY` is valid
3. Verify `STELLAR_NETWORK` is set correctly (TESTNET or PUBLIC)
4. Check DNS resolution for Horizon
5. Review firewall/proxy rules
6. Enable `DEBUG=1` for detailed error logging

### Alert Threshold Not Triggering

1. Verify `GAS_BALANCE_ALERT_THRESHOLD_XLM` is set correctly
2. Verify admin wallet actually has low XLM
3. Verify Stellar Horizon API is reachable
4. Check `STELLAR_NETWORK` is set correctly
5. Enable `DEBUG=1` for verbose logging
6. Verify at least 1 hour has passed since last alert (rate limiting)

### Disabling Alerts

To temporarily disable alerts without stopping the service:

- Set `GAS_BALANCE_ALERT_THRESHOLD_XLM` to an extremely high value (e.g., `999999`)

## Related Environment Variables

| Variable | Purpose | Default | Required |
|----------|---------|---------|----------|
| `STELLAR_NETWORK` | Network to monitor (TESTNET or PUBLIC) | TESTNET | No |
| `SOROBAN_ADMIN_SECRET` | Admin wallet secret (priority 1) | - | If ORACLE_SECRET_KEY not set |
| `ORACLE_SECRET_KEY` | Admin wallet secret (priority 2, fallback) | - | If SOROBAN_ADMIN_SECRET not set |
| `DISCORD_WEBHOOK_URL` | Discord webhook for alerts | - | **Yes** |
| `GAS_BALANCE_ALERT_THRESHOLD_XLM` | Balance alert threshold | 20 | No |
| `DEBUG` | Enable verbose logging | unset | No |

## Implementation Details

### Lazy Singleton Factory Pattern

The service uses a lazy singleton to defer initialization:

```typescript
let _instance: GasBalanceMonitorService | null = null;

export function getGasBalanceMonitorService(): GasBalanceMonitorService {
    if (!_instance) {
        _instance = new GasBalanceMonitorService();
    }
    return _instance;
}
```

This prevents Keypair.fromSecret from running at import time, which would crash if environment variables are missing.

### Service Lifecycle

- Gets created lazily on first call to `getGasBalanceMonitorService()`
- Loaded and started in `httpServer.listen()` block
- Loads persisted alert time from `/tmp/gas_balance_last_alert_time.json`
- Runs immediate check on startup before periodic timer
- Gracefully stopped on SIGINT/SIGTERM signals
- Logs all lifecycle events with `[GasBalanceMonitor]` prefix

### Balance Check Loop

1. Query Stellar Horizon for account balance
2. Find native (XLM) balance
3. Compare against threshold
4. If below threshold and rate limit OK: send alert
5. Track consecutive failures; escalate after 3
6. Persist alert time to survive restarts

### Rate Limiting & Persistence

- Alert time persisted to `/tmp/gas_balance_last_alert_time.json`
- Max 1 alert per hour (MIN_ALERT_INTERVAL_MS = 3600000 ms)
- Persistence survives process restarts
- Each process instance has independent rate limiting
- Failure escalation separate from balance alert rate limiting

## Best Practices

1. **Set appropriate threshold**: 20 XLM is appropriate for most use cases
2. **Monitor actively**: Check Discord channel regularly for alerts
3. **Plan top-ups**: Use alerts to trigger XLM purchase/transfer workflows
4. **Test in TESTNET**: Verify alerts work before production deployment
5. **Document choices**: Record your threshold selection rationale
6. **Setup notifications**: Use Discord roles/mentions for important alerts
7. **Enable DEBUG in dev**: Set `DEBUG=1` during development/troubleshooting
8. **Persist for containers**: Consider database storage for alert timing in production

## Known Limitations

- Rate limiting is per process; multiple instances have independent limits
- Alert time persisted to `/tmp/` may not survive container restarts
- Wallet address intentionally omitted from alerts (security)
- Condition: balance < threshold (not <=)
- No dynamic threshold adjustment based on transaction volume

## Related Issues/Tasks

- GitHub issue #162: "Automatic Gas Top-up" Alert
- Complements multi-sig and price update functionality
- Reuses existing Discord webhook infrastructure

## Support & Troubleshooting

### Verify Service Started

Look for these logs on startup:

```
⛽ Gas balance monitor service started
[GasBalanceMonitor] Started with 300000ms check interval (threshold: 20 XLM)
```

### Check Current Status

```javascript
const { getGasBalanceMonitorService } = require('./src/services/gasBalanceMonitorService');
const monitor = getGasBalanceMonitorService();
console.log(monitor.getStatus());
```

### Enable Debug Logging

```bash
DEBUG=1 npm start
```

### Test Discord Webhook

```bash
curl -X POST "YOUR_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{
    "embeds": [{
      "title": "Test", 
      "color": 16711680
    }]
  }'
```

### Test Stellar Horizon

```bash
# TESTNET
curl https://horizon-testnet.stellar.org/

# MAINNET  
curl https://horizon.stellar.org/
```

### Check Alert Time Persistence

```bash
cat /tmp/gas_balance_last_alert_time.json
```

Output should show last alert timestamp if any alerts were sent.
