## Description

Introduce PgBouncer as a PostgreSQL connection-pooling proxy for StellarFlow. The runtime database path uses transaction-level pooling to support high-concurrency API traffic while keeping PostgreSQL connection counts and CPU utilization under control.

The implementation adds a configurable PgBouncer service, routes application database traffic through the pooler, preserves a direct database URL for migrations where required, and provides reproducible k6 load-test scenarios for baseline and pooled performance comparison.

## Type of Change

- [ ] Bug fix
- [x] New feature
- [ ] Breaking change
- [x] Documentation update

## Testing

- [x] Tested locally
- [x] Added unit tests
- [ ] Tested on Stellar Testnet (for wallet/contract changes)
- [ ] Baseline load test completed (requires k6 against a running API)
- [ ] PgBouncer load test completed (requires k6 against a running API)
- [ ] PostgreSQL CPU and connection metrics compared (requires sustained benchmark)

## Screenshots (if applicable)

## Related Issues

Closes #913

### Implementation plan

1. Add PgBouncer configuration with transaction-level pooling, client limits, pool sizing, reserve capacity, health checks, and configurable credentials.
2. Add PgBouncer to the local Docker Compose stack and route runtime application connections through it.
3. Keep migration and administrative database operations on a direct PostgreSQL URL when transaction pooling is incompatible with those operations.
4. Tune Prisma and SQLAlchemy client-side pooling so the application does not create an oversized pool in front of PgBouncer.
5. Review transaction, advisory-lock, prepared-statement, and session-state usage for transaction-pool compatibility.
6. Add PgBouncer and PostgreSQL observability for client connections, server connections, waiting clients, pool utilization, latency, and errors.
7. Use the existing k6 load-test structure to add baseline and PgBouncer stress scenarios covering representative read and authenticated API traffic.
8. Compare throughput, p50/p95/p99 latency, error rates, PostgreSQL connection counts, and CPU behavior under sustained and burst traffic.
9. Document configuration, startup, migration, benchmark, and rollback procedures.

### Tests to carry out

- Validate PgBouncer configuration and Docker health checks.
- Run database migrations through the supported direct connection path.
- Run the existing backend test suites with PgBouncer enabled.
- Run a low-concurrency k6 smoke test.
- Run sustained high-concurrency stress tests against direct PostgreSQL and PgBouncer.
- Record PostgreSQL CPU, active connections, PgBouncer pool statistics, latency percentiles, throughput, and error rates.

### Implementation completed

- Added `pgbouncer/pgbouncer.ini` with transaction pooling, a 10,000-client limit, bounded default/reserve pools, health checks, and timeout controls.
- Added PgBouncer to `docker-compose.yml` on port `6432` and routed the Compose runtime database URL through it.
- Preserved `DIRECT_DATABASE_URL` for migrations and administrative database operations.
- Bounded Node `pg` and SQLAlchemy client pools and disabled asyncpg statement caching when PgBouncer is enabled.
- Added `tests/load/pgbouncer-stress.js` for repeatable high-concurrency comparison testing.

### Verification completed

- Docker Compose configuration validation passed.
- PostgreSQL reached a healthy state.
- PgBouncer reached a healthy state and listened on port `6432`.
- A real SQL query through PgBouncer returned the expected database and user.
- `npm run build` passed.
