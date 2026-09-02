# System health watchdog (Issue #797)

The watchdog polls Stellar Horizon, Soroban RPC, and PostgreSQL every five
seconds. It also supervises registered worker heartbeats and the Soroban event
ingestion queue. Degradation alerts use the existing `DISCORD_WEBHOOK_URL`,
`SLACK_WEBHOOK_URL`, `NOTIFICATION_PLATFORMS`, and
`WEBHOOK_RATE_LIMIT_MINUTES` settings.

| Variable                             | Default | Description                                    |
| ------------------------------------ | ------- | ---------------------------------------------- |
| `WATCHDOG_INGESTION_QUEUE_MAX_DEPTH` | `800`   | Queue depth that triggers a degradation alert. |
