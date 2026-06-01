Closes #347

## Problem
Analytical dashboard queries bog down when scanning unindexed columns 
in large telemetry tables, especially for deep historical metrics.

## Solution
Added composite index migration files in `src/database/migrations/`:

### Files added
- `001_telemetry_query_indexes.sql` — 10 composite indexes across 6 tables
- `001_telemetry_query_indexes_rollback.sql` — rollback script

### Indexes added
| Table | Index | Query accelerated |
|---|---|---|
| `PriceHistory` | `source, timestamp` | Provider history over time |
| `PriceHistory` | `currency, source, timestamp` | Dashboard per-pair per-provider |
| `OnChainPrice` | `currency, ledgerSeq` | Ledger history pagination |
| `OnChainPrice` | `currency, confirmedAt` | Time-range dashboard queries |
| `RawData` | `provider, currency, fetchedAt` | Validator/provider telemetry |
| `OhlcCandle` | `currency, granularity, openTime` + INCLUDE | Sparkline charts |
| `ErrorLog` | `providerName, occurredAt` | Recent errors per validator |
| `ProviderReputation` | `status, reliabilityScore` | Validator ranking |
| `ProviderReputation` | `providerName, lastUpdated` | Staleness monitoring |
| `ComplianceMetadata` | `eventType, resolved, createdAt` | Latency violation dashboard |

All indexes use `CONCURRENTLY` to avoid table locks in production.