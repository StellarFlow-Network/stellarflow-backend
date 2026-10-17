# Pool Analytics, Portfolio Balances, and Mempool Monitoring

## Pool endpoints

`GET /api/v1/pools/{pool_id}/price-impact-heatmap` returns quote-asset output and price impact for USD trade tiers `$100`, `$1,000`, `$10,000`, `$100,000`, and `$1,000,000`. Configure live market data with `POOL_MARKET_DATA_JSON`, keyed by pool ID/address:

```json
{
  "CPOOLADDRESS": {
    "pool_id": "CPOOLADDRESS",
    "asset_pair": "XLM/USDC",
    "total_liquidity_usd": 250000,
    "current_price": 0.12,
    "quote_asset_price_usd": 1,
    "range_lower_price": 0.108,
    "range_upper_price": 0.132,
    "fee_tier_bps": 30
  }
}
```

The heatmap is an estimate based on configured active-range liquidity, not a transaction simulation against a live contract. Without market data, unknown pools return 404.

`GET /api/v1/pools/{pool_id}/apy-breakdown` reads seven-day data from `PoolVolumeAnalytics` and active reward rates from `PoolRewardEmission`. At least seven daily pool analytics samples are required. The reward table is created by the `20261017100000_add_pool_reward_emissions` Prisma migration; populate emission rates in token units per second and maintain the token USD price.

## Portfolio balances

`GET /api/v1/portfolio/{address}/balances` serves a Redis-cached snapshot for 30 seconds. Stellar balances use `HORIZON_URL` (defaults to `https://horizon.stellar.org`). Configure Soroban-aware indexer adapters as `SOROBAN_BALANCE_INDEXERS` JSON, each with `name` and `indexer_url`; the indexer must return `{"balances":[{"asset_code":"...","contract_id":"...","amount":"..."}]}` from `/accounts/{address}/balances`.

Configure EVM networks with `PORTFOLIO_EVM_NETWORKS` JSON, for example:

```json
[{"name":"ethereum","rpc_url":"https://rpc.example","native_symbol":"ETH","tokens":[{"asset_code":"USDC","contract_address":"0x...","decimals":6}]}]
```

When the API path's address is a portfolio identity rather than a chain account, configure `PORTFOLIO_ADDRESS_MAP` as JSON keyed by that identity, with network names mapped to their account addresses:

```json
{"portfolio-owner":{"stellar":"G...","ethereum":"0x..."}}
```

The API worker refreshes addresses requested by that worker every 30 seconds. Provider failures are reported per network in the response's `errors` array.

## Sandwich monitoring

The API worker consumes normalized pending transactions from the Redis stream named by `MEMPOOL_TRANSACTION_STREAM` (default `stellarflow:mempool:transactions`). Each stream field `event` is JSON. Emit ordered `front_run`, `victim`, and `back_run` events with `pool_address`, `tx_hash`, `side`, and `attacker_address` on attacker legs. Victim events also need `user_address`, `expected_output`, `actual_output`, and `slippage_tolerance_percent`; the front-run direction matches the victim and the back-run direction reverses it. The monitor detects the completed sequence, calculates `delta_s_percent`, and posts an alert to `SANDWICH_ALERT_WEBHOOK_URL`.

The repo does not include a Stellar mempool feed. An upstream node/indexer must publish pending-transaction observations; `publish_mempool_transaction` is available to Python producers. Counter-defense submission is disabled by default. To enable it, set `SANDWICH_DEFENSE_ENABLED=true` and `SANDWICH_DEFENSE_CALLBACK=module:function` to a deployment-owned callback that performs the authorized, signed action.
