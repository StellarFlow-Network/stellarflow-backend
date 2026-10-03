"""tests/test_treasury_yield_sweeper.py — Tests for Treasury Staked Asset Yield Sweeper Bot (#974)."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.allocation import VaultStrategy
from app.models.treasury import (
    TreasuryYieldAllocation,
    TreasuryYieldReport,
    TreasuryYieldSweep,
)
from app.services.treasury_yield_sweeper import (
    DEFAULT_CLAIM_THRESHOLD_USD,
    DEFAULT_RESERVE_LIQUIDITY_POOL_ID,
    TreasurySweeperError,
    TreasuryYieldSweeper,
)


class MockRelayerPool:
    """Mock relayer pool for deterministic sequence management."""

    def __init__(self):
        self.accounts = ["GABC...", "GDEF..."]

    def acquire_account(self, seed_map=None):
        return ("GABC...", 1001)

    def release_account(self, account, sequence, success=True):
        pass


@pytest.fixture
def relayer_pool():
    return MockRelayerPool()


@pytest.fixture
def sweeper(relayer_pool):
    return TreasuryYieldSweeper(
        relayer_pool=relayer_pool,
        treasury_account="GTREASURY_TEST",
        claim_threshold_usd=Decimal("500.00"),
        default_reserve_pool_id="pool_usdc_xlm_reserve",
    )


# ---------------------------------------------------------------------------
# Model Tests
# ---------------------------------------------------------------------------


def test_treasury_yield_sweep_instantiation():
    now = datetime(2026, 9, 30, 12, 0, 0, tzinfo=timezone.utc)
    sweep = TreasuryYieldSweep(
        id="sweep-123",
        strategy_id="vault_staking_usdc",
        vault_address="CV123",
        reward_asset="USDC",
        uncollected_amount=Decimal("650.00"),
        reward_asset_price_usd=Decimal("1.00"),
        uncollected_usd_value=Decimal("650.00"),
        claim_threshold_usd=Decimal("500.00"),
        status="ROUTED",
        claim_transaction_hash="hash-claim-1",
        route_transaction_hash="hash-route-1",
        liquidity_pool_id="pool_usdc_xlm_reserve",
        routed_amount=Decimal("650.00"),
        evaluated_at=now,
        claimed_at=now,
        routed_at=now,
    )
    assert sweep.id == "sweep-123"
    assert sweep.uncollected_usd_value == Decimal("650.00")
    assert sweep.status == "ROUTED"
    assert sweep.claim_transaction_hash == "hash-claim-1"
    assert sweep.route_transaction_hash == "hash-route-1"
    assert "vault_staking_usdc" in repr(sweep)


# ---------------------------------------------------------------------------
# Calculation Tests
# ---------------------------------------------------------------------------


def test_calculate_uncollected_rewards(sweeper):
    start = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    # Exactly half a 365-day year later
    current = start + timedelta(seconds=15768000)

    # 100,000 staked * 0.10 APY * 0.5 year = 5,000 rewards
    reward = sweeper.calculate_uncollected_rewards(
        staked_amount=Decimal("100000"),
        apy=Decimal("0.10"),
        start_time=start,
        current_time=current,
    )
    assert reward == Decimal("5000.0000000")


def test_calculate_uncollected_rewards_zero_elapsed(sweeper):
    now = datetime(2026, 9, 30, 12, 0, 0, tzinfo=timezone.utc)
    reward = sweeper.calculate_uncollected_rewards(
        staked_amount=Decimal("100000"),
        apy=Decimal("0.10"),
        start_time=now,
        current_time=now,
    )
    assert reward == Decimal("0")


# ---------------------------------------------------------------------------
# Sweep Execution Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sweep_triggers_claim_and_route_when_rewards_exceed_500_usd(sweeper):
    now = datetime(2026, 9, 30, 12, 0, 0, tzinfo=timezone.utc)

    allocation = TreasuryYieldAllocation(
        id="alloc-1",
        strategy_id="vault_usdc_staking",
        vault_address="CVAULT_USDC",
        amount=Decimal("100000"),
        apy=Decimal("0.08"),
        status="STAKED",
        window_start=now - timedelta(days=60),
    )

    strategy = VaultStrategy(
        id="vault_usdc_staking",
        vault_address="CVAULT_USDC",
        strategy_type="STAKING",
        asset="USDC",
        current_apy=Decimal("0.08"),
        tvl=Decimal("500000"),
        risk_score=Decimal("0.2"),
        enabled=True,
    )

    mock_db = AsyncMock()

    # Mock fetching active allocations
    async def mock_execute(stmt):
        mock_result = MagicMock()
        # Distinguish between allocations query and strategy query
        stmt_str = str(stmt)
        if "vault_strategy" in stmt_str:
            mock_result.scalars.return_value.all.return_value = [strategy]
        else:
            mock_result.scalars.return_value.all.return_value = [allocation]
        return mock_result

    mock_db.execute.side_effect = mock_execute

    # Explicit rewards: 650 USDC = $650 USD value (> $500 USD)
    explicit_rewards = {"vault_usdc_staking": Decimal("650.00")}

    results = await sweeper.sweep_staked_rewards(
        db=mock_db,
        current_time=now,
        explicit_rewards=explicit_rewards,
    )

    assert len(results) == 1
    res = results[0]
    assert res["status"] == "ROUTED"
    assert res["uncollected_amount"] == 650.0
    assert res["uncollected_usd_value"] == 650.0
    assert res["claim_transaction_hash"] is not None
    assert res["route_transaction_hash"] is not None
    assert res["liquidity_pool_id"] == "pool_usdc_xlm_reserve"

    # Database add and commit called
    assert mock_db.add.called
    assert mock_db.commit.called


@pytest.mark.asyncio
async def test_sweep_skips_when_rewards_below_or_equal_500_usd(sweeper):
    now = datetime(2026, 9, 30, 12, 0, 0, tzinfo=timezone.utc)

    allocation = TreasuryYieldAllocation(
        id="alloc-2",
        strategy_id="vault_usdc_staking",
        vault_address="CVAULT_USDC",
        amount=Decimal("10000"),
        apy=Decimal("0.05"),
        status="STAKED",
        window_start=now - timedelta(days=10),
    )

    strategy = VaultStrategy(
        id="vault_usdc_staking",
        vault_address="CVAULT_USDC",
        strategy_type="STAKING",
        asset="USDC",
        current_apy=Decimal("0.05"),
        tvl=Decimal("100000"),
        risk_score=Decimal("0.1"),
        enabled=True,
    )

    mock_db = AsyncMock()

    async def mock_execute(stmt):
        mock_result = MagicMock()
        stmt_str = str(stmt)
        if "vault_strategy" in stmt_str:
            mock_result.scalars.return_value.all.return_value = [strategy]
        else:
            mock_result.scalars.return_value.all.return_value = [allocation]
        return mock_result

    mock_db.execute.side_effect = mock_execute

    # 400 USDC = $400 USD (below $500 threshold)
    explicit_rewards = {"vault_usdc_staking": Decimal("400.00")}

    results = await sweeper.sweep_staked_rewards(
        db=mock_db,
        current_time=now,
        explicit_rewards=explicit_rewards,
    )

    assert len(results) == 1
    res = results[0]
    assert res["status"] == "SKIPPED"
    assert res["uncollected_amount"] == 400.0
    assert "claim_transaction_hash" not in res


@pytest.mark.asyncio
async def test_sweep_multi_asset_pricing(sweeper):
    now = datetime(2026, 9, 30, 12, 0, 0, tzinfo=timezone.utc)

    allocation = TreasuryYieldAllocation(
        id="alloc-xlm",
        strategy_id="vault_xlm_staking",
        vault_address="CVAULT_XLM",
        amount=Decimal("500000"),
        apy=Decimal("0.06"),
        status="STAKED",
        window_start=now - timedelta(days=30),
    )

    strategy = VaultStrategy(
        id="vault_xlm_staking",
        vault_address="CVAULT_XLM",
        strategy_type="STAKING",
        asset="XLM",
        current_apy=Decimal("0.06"),
        tvl=Decimal("1000000"),
        risk_score=Decimal("0.2"),
        enabled=True,
    )

    mock_db = AsyncMock()

    async def mock_execute(stmt):
        mock_result = MagicMock()
        stmt_str = str(stmt)
        if "vault_strategy" in stmt_str:
            mock_result.scalars.return_value.all.return_value = [strategy]
        else:
            mock_result.scalars.return_value.all.return_value = [allocation]
        return mock_result

    mock_db.execute.side_effect = mock_execute

    # 5,000 XLM at $0.12 = $600 USD (> $500 threshold)
    explicit_rewards = {"vault_xlm_staking": Decimal("5000.00")}
    prices = {"XLM": Decimal("0.12"), "USDC": Decimal("1.0")}

    results = await sweeper.sweep_staked_rewards(
        db=mock_db,
        current_time=now,
        asset_prices_usd=prices,
        explicit_rewards=explicit_rewards,
    )

    assert len(results) == 1
    res = results[0]
    assert res["status"] == "ROUTED"
    assert res["uncollected_usd_value"] == 600.0
    assert res["routed_amount"] == 5000.0
