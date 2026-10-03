# Capital Rebalancing System 💰

## Overview

The Capital Rebalancing System automatically optimizes capital allocation across multiple vault yield strategies to maximize aggregate APY while managing risk exposure. The system uses convex optimization algorithms to compute target allocations and executes rebalancing transactions when drift exceeds configurable thresholds.

## Features 🚀

### 1. **Convex Yield Optimization** 📊
- Mean-variance portfolio optimization using CVXPY
- Computes target allocation vectors $W_{target}$ that maximize expected returns
- Risk-adjusted allocation with configurable risk aversion parameter λ
- Capacity-aware allocation respecting vault limits
- Diversification constraints (max single allocation, minimum allocation)

### 2. **Automated Drift Detection** ⏱️
- Continuously monitors allocation drift: $|W_{current} - W_{target}|$
- Triggers rebalancing when drift exceeds threshold (default: 5%)
- Per-strategy drift tracking for granular monitoring

### 3. **Transaction Execution** 🔑
- Automated relayer signer pool for transaction submission
- Distributed locking using Redlock algorithm prevents concurrent vault operations
- Sequence number coordination across multiple relayer accounts
- Automatic retry and resync on transaction failures

### 4. **Audit Trail** 📝
- Complete rebalancing history with status tracking
- Before/after APY comparison for performance validation
- Transaction hashes for on-chain verification
- Capital movement tracking (from → to)
- Execution cost accounting

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                   Capital Rebalancer                         │
│  ┌──────────────────┐  ┌───────────────────────────────┐   │
│  │ Portfolio        │  │ Drift Detection               │   │
│  │ Optimizer        │──▶│ |W_current - W_target| > 5% │   │
│  └──────────────────┘  └───────────────────────────────┘   │
│           │                        │                         │
│           │ Target Allocations     │ Triggers Rebalancing    │
│           ▼                        ▼                         │
│  ┌────────────────────────────────────────────────────┐    │
│  │         Rebalancing Execution Engine                │    │
│  │  • Computes capital movements                       │    │
│  │  • Acquires vault operation locks                   │    │
│  │  • Submits deposit/withdrawal transactions          │    │
│  │  • Updates allocation state                         │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────────┐
        │    Relayer Pool & Nonce Manager     │
        │  • Multi-account load balancing     │
        │  • Sequence number coordination     │
        │  • Automatic Horizon resync         │
        └─────────────────────────────────────┘
```

### Database Schema

#### `vault_strategy`
Stores yield strategy configuration and APY tracking.

```sql
CREATE TABLE vault_strategy (
    id VARCHAR(128) PRIMARY KEY,
    vault_address VARCHAR(56) NOT NULL,
    strategy_type VARCHAR(32) NOT NULL, -- LENDING, STAKING, LP_FARMING
    asset VARCHAR(16) NOT NULL,
    current_apy NUMERIC(10,7) NOT NULL,
    historical_apy_mean NUMERIC(10,7),
    historical_apy_std NUMERIC(10,7),
    tvl NUMERIC(32,7) NOT NULL,
    capacity NUMERIC(32,7), -- NULL = unlimited
    risk_score NUMERIC(3,2) NOT NULL, -- 0.0-1.0
    enabled BOOLEAN NOT NULL DEFAULT true,
    metadata JSONB,
    last_apy_update TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
```

#### `capital_allocation`
Current capital allocation across vault strategies.

```sql
CREATE TABLE capital_allocation (
    id VARCHAR(64) PRIMARY KEY,
    strategy_id VARCHAR(128) NOT NULL UNIQUE,
    allocated_amount NUMERIC(32,7) NOT NULL,
    target_weight NUMERIC(5,4) NOT NULL, -- Fractional (sums to 1.0)
    current_weight NUMERIC(5,4) NOT NULL,
    last_rebalance TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
```

#### `rebalancing_history`
Audit trail of rebalancing operations.

```sql
CREATE TABLE rebalancing_history (
    id VARCHAR(64) PRIMARY KEY,
    triggered_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(16) NOT NULL, -- PENDING, IN_PROGRESS, COMPLETED, FAILED
    total_capital NUMERIC(32,7) NOT NULL,
    drift_magnitude NUMERIC(5,4) NOT NULL,
    target_allocations JSONB NOT NULL,
    previous_allocations JSONB NOT NULL,
    movements JSONB,
    transaction_hashes JSONB,
    aggregate_apy_before NUMERIC(10,7),
    aggregate_apy_after NUMERIC(10,7),
    execution_cost NUMERIC(18,7),
    error_message TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
```

## API Endpoints

### Strategy Management

#### `POST /api/v1/rebalancing/strategies`
Register a new vault strategy.

**Request:**
```json
{
  "id": "aave_usdc_lending",
  "vault_address": "GABC...",
  "strategy_type": "LENDING",
  "asset": "USDC",
  "current_apy": 0.0523,
  "historical_apy_std": 0.008,
  "tvl": 1000000.0,
  "capacity": 5000000.0,
  "risk_score": 0.25,
  "enabled": true
}
```

#### `GET /api/v1/rebalancing/strategies`
List all vault strategies.

**Query Parameters:**
- `enabled_only`: Filter to only enabled strategies (default: false)

#### `POST /api/v1/rebalancing/strategies/update-apy`
Update a strategy's current APY.

**Request:**
```json
{
  "strategy_id": "aave_usdc_lending",
  "current_apy": 0.0548
}
```

### Allocation Monitoring

#### `GET /api/v1/rebalancing/allocations`
Get current capital allocations across all strategies.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "abc123",
      "strategy_id": "aave_usdc_lending",
      "allocated_amount": 450000.0,
      "target_weight": 0.45,
      "current_weight": 0.45,
      "last_rebalance": "2026-09-24T10:30:00Z",
      "updated_at": "2026-09-24T10:30:00Z"
    }
  ]
}
```

#### `GET /api/v1/rebalancing/drift`
Check current allocation drift without executing rebalancing.

**Response:**
```json
{
  "max_drift": 0.073,
  "drift_threshold": 0.05,
  "rebalancing_needed": true,
  "drift_per_strategy": {
    "aave_usdc_lending": 0.073,
    "compound_eth_lending": 0.022
  },
  "current_allocations": {
    "aave_usdc_lending": 0.377,
    "compound_eth_lending": 0.623
  },
  "target_allocations": {
    "aave_usdc_lending": 0.450,
    "compound_eth_lending": 0.550
  }
}
```

#### `GET /api/v1/rebalancing/plan`
Preview the ordered re-allocation instructions without executing them. This is
the same target vector the 6-hourly re-evaluation computes, plus the
step-by-step `WITHDRAW`/`DEPOSIT` instructions handed to the auto-harvest
worker. Withdrawals are listed before deposits so capital is freed before it is
redeployed.

**Response:**
```json
{
  "rebalancing_needed": true,
  "total_capital": 1000000.0,
  "max_drift": 0.073,
  "drift_threshold": 0.05,
  "current_allocations": {"aave_usdc_lending": 0.377, "compound_eth_lending": 0.623},
  "target_allocations": {"aave_usdc_lending": 0.45, "compound_eth_lending": 0.55},
  "instructions": [
    {
      "step": 1,
      "action": "WITHDRAW",
      "direction": "DECREASE",
      "strategy_id": "compound_eth_lending",
      "vault_address": "GDEF0987654321",
      "risk_score": 0.45,
      "amount": 73000.0,
      "delta_amount": -73000.0,
      "delta_weight": -0.073,
      "current_weight": 0.623,
      "target_weight": 0.55
    },
    {
      "step": 2,
      "action": "DEPOSIT",
      "direction": "INCREASE",
      "strategy_id": "aave_usdc_lending",
      "vault_address": "GABC1234567890",
      "risk_score": 0.25,
      "amount": 73000.0,
      "delta_amount": 73000.0,
      "delta_weight": 0.073,
      "current_weight": 0.377,
      "target_weight": 0.45
    }
  ],
  "expected_apy": 0.0512,
  "capital_deployed_fraction": 1.0,
  "portfolio_risk_score": 0.39,
  "message": "Rebalancing required"
}
```

### Rebalancing Operations

#### `POST /api/v1/rebalancing/trigger`
Manually trigger capital rebalancing.

**Request:**
```json
{
  "force": false
}
```

**Response:**
```json
{
  "success": true,
  "rebalancing_id": "a1b2c3d4e5f6...",
  "message": "Rebalancing operation initiated successfully"
}
```

#### `GET /api/v1/rebalancing/history`
List historical rebalancing operations.

**Query Parameters:**
- `limit`: Number of records to return (default: 50, max: 500)
- `offset`: Pagination offset (default: 0)
- `status`: Filter by status (PENDING, IN_PROGRESS, COMPLETED, FAILED)

#### `GET /api/v1/rebalancing/history/{rebalancing_id}`
Get details of a specific rebalancing operation.

**Response:**
```json
{
  "id": "a1b2c3d4e5f6...",
  "triggered_at": "2026-09-24T10:00:00Z",
  "completed_at": "2026-09-24T10:05:23Z",
  "status": "COMPLETED",
  "total_capital": 1000000.0,
  "drift_magnitude": 0.073,
  "target_allocations": {
    "aave_usdc_lending": 0.45,
    "compound_eth_lending": 0.55
  },
  "previous_allocations": {
    "aave_usdc_lending": 0.377,
    "compound_eth_lending": 0.623
  },
  "movements": [
    {
      "strategy_id": "aave_usdc_lending",
      "delta_amount": 73000.0,
      "direction": "INCREASE"
    },
    {
      "strategy_id": "compound_eth_lending",
      "delta_amount": -73000.0,
      "direction": "DECREASE"
    }
  ],
  "transaction_hashes": ["tx1hash...", "tx2hash..."],
  "aggregate_apy_before": 0.0485,
  "aggregate_apy_after": 0.0512,
  "execution_cost": 0.42
}
```

## Configuration

### Environment Variables

```bash
# Portfolio Optimization
PORTFOLIO_RISK_AVERSION=0.5          # Risk aversion parameter λ (0-10)
PORTFOLIO_MAX_SINGLE_ALLOCATION=0.4  # Max weight for single strategy (0-1)
PORTFOLIO_MIN_ALLOCATION=0.01        # Min allocation to avoid dust
PORTFOLIO_MAX_STRATEGY_RISK=1.0      # Max risk_score eligible for allocation (0-1)
PORTFOLIO_MAX_PORTFOLIO_RISK=1.0     # Max capital-weighted portfolio risk score (0-1)

# Rebalancing Thresholds
REBALANCING_DRIFT_THRESHOLD=0.05     # Trigger rebalancing at 5% drift

# Treasury Configuration
TREASURY_ACCOUNT=GABC...             # Treasury account managing capital

# Relayer Pool (from existing infrastructure)
RELAYER_ACCOUNTS=GABC...,GDEF...     # Comma-separated relayer public keys
HORIZON_URL=https://horizon-testnet.stellar.org
REDIS_URL=redis://localhost:6379/0

# Vault Locking
VAULT_LOCK_KEY_PREFIX=stellarflow:vault:lock
REDLOCK_REDIS_URLS=redis://localhost:6379/0
```

## Automated Execution

### Celery Task

The optimal allocation vector is re-evaluated **every 6 hours** by the
`auto_rebalance_capital` Celery task, which is registered in
`app/celery_app.py`:

```python
from app.tasks import auto_rebalance_capital

# Trigger manually
result = auto_rebalance_capital.delay()

# Registered in app/celery_app.py beat_schedule
'auto-rebalance-capital': {
    'task': 'app.tasks.auto_rebalance_capital',
    'schedule': crontab(minute='0', hour='*/6'),  # Every 6 hours
},
```

### Task Response

```json
{
  "success": true,
  "rebalancing_executed": true,
  "rebalancing_id": "a1b2c3d4e5f6...",
  "timestamp": "2026-09-24T10:30:00Z"
}
```

## Optimization Algorithm

### Mean-Variance Optimization

The portfolio optimizer solves the following convex optimization problem:

```
maximize:   E[R] - λ * Var[R]
subject to: 
    - Σ w_i <= 1                          (capital deployed, residual stays liquid)
    - w_i >= min_allocation               (minimum allocation)
    - w_i <= max_single_allocation        (diversification)
    - w_i * total_capital <= capacity_i   (vault capacity)
    - risk_score_i <= max_strategy_risk   (per-strategy risk gate)
    - Σ risk_score_i * w_i <= max_portfolio_risk  (risk weight budget)
    - w_i >= 0                            (long-only)

where:
    w_i = portfolio weight for strategy i
    E[R] = expected return (weighted average APY)
    Var[R] = portfolio variance (from covariance matrix)
    λ = risk aversion parameter
```

`Σ w_i <= 1` (rather than `== 1`) lets the optimizer leave capital undeployed
when the available vault capacity, the diversification cap or the risk budget
cannot absorb all of it. Strategies whose `risk_score` exceeds
`max_strategy_risk` are excluded before the problem is solved; when the
portfolio risk budget binds, the target vector is scaled down and the residual
stays liquid.

### Fallback Strategy

When CVXPY is unavailable, the system falls back to proportional allocation:

```python
w_i = APY_i / Σ APY_j
```

The raw proportional weights are then **water-filled** against the per-strategy
caps (capacity and `max_single_allocation`): any overflow is redistributed only
to strategies that still have headroom, so a capped strategy is never pushed
back above its cap. If the caps cannot absorb all the capital, or the portfolio
risk budget binds, the residual is left undeployed.

## Installation

### Dependencies

```bash
# Core dependencies (already in requirements.txt)
pip install fastapi sqlalchemy asyncpg redis celery

# Optimization library (optional but recommended)
pip install cvxpy

# For development
pip install pytest pytest-asyncio
```

### Database Migration

```bash
# Apply the migration
alembic upgrade head

# Verify tables were created
psql $DATABASE_URL -c "\d vault_strategy"
psql $DATABASE_URL -c "\d capital_allocation"
psql $DATABASE_URL -c "\d rebalancing_history"
```

## Usage Examples

### 1. Register Strategies

```bash
curl -X POST http://localhost:8000/api/v1/rebalancing/strategies \
  -H "Content-Type: application/json" \
  -d '{
    "id": "aave_usdc_lending",
    "vault_address": "GABC...",
    "strategy_type": "LENDING",
    "asset": "USDC",
    "current_apy": 0.0523,
    "historical_apy_std": 0.008,
    "tvl": 1000000.0,
    "risk_score": 0.25,
    "enabled": true
  }'
```

### 2. Check Drift

```bash
curl http://localhost:8000/api/v1/rebalancing/drift
```

### 3. Trigger Rebalancing

```bash
curl -X POST http://localhost:8000/api/v1/rebalancing/trigger \
  -H "Content-Type: application/json" \
  -d '{"force": false}'
```

### 4. Monitor History

```bash
curl "http://localhost:8000/api/v1/rebalancing/history?limit=10&status=COMPLETED"
```

## Monitoring & Observability

### Structured Logging

All operations emit structured logs via `structlog`:

```json
{
  "event": "rebalancing_completed",
  "component": "CapitalRebalancer",
  "rebalancing_id": "a1b2c3d4...",
  "tx_count": 2,
  "apy_improvement": 0.0027,
  "timestamp": "2026-09-24T10:05:23Z"
}
```

### Key Metrics

Monitor these events:
- `portfolio_optimizer.allocations_computed` - Optimization success
- `capital_rebalancer.rebalancing_triggered` - Rebalancing initiated
- `capital_rebalancer.rebalancing_completed` - Successful completion
- `capital_rebalancer.rebalancing_failed` - Execution failures
- `vault_lock.acquired` - Lock acquisition for audit

### Database Queries

```sql
-- Recent rebalancing operations
SELECT id, status, drift_magnitude, aggregate_apy_after - aggregate_apy_before AS apy_improvement
FROM rebalancing_history
ORDER BY triggered_at DESC
LIMIT 10;

-- Current allocations
SELECT s.id, s.current_apy, a.current_weight, a.allocated_amount
FROM vault_strategy s
JOIN capital_allocation a ON s.id = a.strategy_id
WHERE s.enabled = true;

-- Failed rebalancings requiring investigation
SELECT id, triggered_at, error_message
FROM rebalancing_history
WHERE status = 'FAILED'
ORDER BY triggered_at DESC;
```

## Security Considerations

### Vault Operation Locking
- Redlock algorithm prevents concurrent rebalancing operations
- Account-level locking ensures serial vault state changes
- TTL-based deadlock prevention (default: 30s)

### Transaction Safety
- Sequence number coordination prevents nonce collisions
- Automatic Horizon resync on `tx_bad_seq` errors
- Distributed relayer pool for high availability

### Access Control
Consider implementing:
- Role-based access control for manual rebalancing triggers
- Multi-signature approval for large capital movements
- Rate limiting on rebalancing frequency

## Performance

### Optimization Complexity
- CVXPY solver: O(n³) for n strategies (typically < 100ms for n=10)
- Fallback proportional: O(n) - instant

### Transaction Execution
- Parallel movement execution (future enhancement)
- Current: Sequential with ~2s per vault operation
- Expected: 10-20s for typical 5-strategy rebalancing

### Database Impact
- Allocation reads: < 10ms (indexed queries)
- History writes: < 5ms (single insert)
- No long-running transactions

## Troubleshooting

### Rebalancing Not Triggering

1. Check drift:
   ```bash
   curl http://localhost:8000/api/v1/rebalancing/drift
   ```

2. Verify strategies are enabled:
   ```sql
   SELECT COUNT(*) FROM vault_strategy WHERE enabled = true;
   ```

3. Check threshold configuration:
   ```bash
   echo $REBALANCING_DRIFT_THRESHOLD
   ```

### Optimization Failures

1. Verify CVXPY installation:
   ```python
   import cvxpy as cp
   print(cp.installed_solvers())
   ```

2. Check strategy constraints:
   ```sql
   SELECT id, capacity, tvl FROM vault_strategy WHERE capacity < tvl;
   ```

### Transaction Execution Errors

1. Check relayer pool health:
   ```bash
   redis-cli GET stellarflow:nonce:GABC...
   ```

2. Verify Horizon connectivity:
   ```bash
   curl $HORIZON_URL/accounts/$TREASURY_ACCOUNT
   ```

3. Review failed rebalancing logs:
   ```sql
   SELECT error_message FROM rebalancing_history WHERE status = 'FAILED' ORDER BY triggered_at DESC LIMIT 1;
   ```

## Future Enhancements

- [ ] Multi-asset portfolio optimization (currently single-asset)
- [ ] Correlation-based covariance matrix (currently diagonal)
- [ ] Transaction batching for parallel execution
- [ ] Machine learning APY prediction
- [ ] Risk parity allocation strategy
- [ ] Dynamic rebalancing frequency based on volatility
- [ ] Gas cost optimization (wait for lower fees)
- [ ] WebSocket notifications for rebalancing events

## License

Proprietary - StellarFlow Backend Services

## Support

For questions or issues:
- Internal documentation: https://docs.stellarflow.internal
- Issue tracker: https://github.com/stellarflow/backend/issues
- Team channel: #backend-engineering
