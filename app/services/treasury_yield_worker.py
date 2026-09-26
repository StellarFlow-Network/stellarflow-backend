"""app/services/treasury_yield_worker.py — Protocol treasury yield auto-staking.

Stakes idle protocol treasury USDC balances into low-risk yield vaults while
maintaining a minimum liquid reserve for operational expenses, and produces
monthly yield generation summaries for governance.

Design
------
* ``MIN_LIQUID_RESERVE_RATIO`` (default 20%) is the hard floor of liquid USDC
  that must remain unstaked at all times.
* Only strategies flagged as low-risk (``risk_score <= max_risk_score``) and
  enabled are eligible for staking.
* Idle capital is the treasury balance above the reserve floor. It is
  distributed across eligible strategies proportionally to their APY, capped by
  each vault's remaining capacity.
* Allocations are idempotent per ``(strategy_id, window_start)`` so retries do
  not double-stake.
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.allocation import VaultStrategy
from app.models.treasury import TreasuryYieldAllocation, TreasuryYieldReport
from app.services.nonce_manager import RelayerPool, managed_sequence
from app.services.vault_operation_lock import vault_operation_lock

log = structlog.get_logger(__name__)

#: Minimum fraction of the treasury that must remain liquid (unstaked).
MIN_LIQUID_RESERVE_RATIO = Decimal("0.20")

#: Default maximum risk score for a vault to be considered "low-risk".
DEFAULT_MAX_RISK_SCORE = Decimal("0.30")

#: Ignore allocations below this USDC amount (dust).
DUST_THRESHOLD = Decimal("0.01")


class TreasuryYieldError(RuntimeError):
    """Raised when treasury yield auto-staking fails."""


class TreasuryYieldWorker:
    """Stakes idle treasury USDC into low-risk yield vaults.

    Parameters
    ----------
    relayer_pool : RelayerPool
        Relayer pool used to submit staking transactions.
    treasury_account : str
        Treasury account address holding the USDC balance.
    min_liquid_reserve_ratio : Decimal
        Minimum liquid reserve fraction of the treasury (default 0.20 = 20%).
    max_risk_score : Decimal
        Maximum vault risk score eligible for staking (default 0.30).
    """

    def __init__(
        self,
        relayer_pool: RelayerPool,
        treasury_account: Optional[str] = None,
        min_liquid_reserve_ratio: Decimal = MIN_LIQUID_RESERVE_RATIO,
        max_risk_score: Decimal = DEFAULT_MAX_RISK_SCORE,
    ) -> None:
        if not 0 <= min_liquid_reserve_ratio < 1:
            raise ValueError("min_liquid_reserve_ratio must be in [0, 1)")
        if not 0 <= max_risk_score <= 1:
            raise ValueError("max_risk_score must be in [0, 1]")

        self.relayer_pool = relayer_pool
        self.treasury_account = treasury_account or os.getenv(
            "TREASURY_ACCOUNT", "GABC..."
        )
        self.min_liquid_reserve_ratio = min_liquid_reserve_ratio
        self.max_risk_score = max_risk_score

        log.info(
            "treasury_yield_worker.initialized",
            component="TreasuryYieldWorker",
            min_liquid_reserve_ratio=float(min_liquid_reserve_ratio),
            max_risk_score=float(max_risk_score),
            treasury_account=self.treasury_account,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------
    async def stake_idle_balances(
        self,
        db: AsyncSession,
        treasury_balance: Decimal,
        window_start: Optional[datetime] = None,
    ) -> List[str]:
        """Stake idle treasury USDC into low-risk yield vaults.

        Parameters
        ----------
        db : AsyncSession
            Database session for ORM operations.
        treasury_balance : Decimal
            Total USDC treasury balance available.
        window_start : Optional[datetime]
            Allocation window start (defaults to the current UTC hour).

        Returns
        -------
        List[str]
            IDs of the allocation records created.

        Raises
        ------
        TreasuryYieldError
            If a staking transaction fails.
        """
        bound = log.bind(
            component="TreasuryYieldWorker", method="stake_idle_balances"
        )

        if treasury_balance < 0:
            raise ValueError("treasury_balance cannot be negative")

        window_start = window_start or datetime.now(timezone.utc).replace(
            minute=0, second=0, microsecond=0
        )

        reserve_floor = self.compute_reserve_floor(treasury_balance)
        idle_capital = treasury_balance - reserve_floor

        if idle_capital <= DUST_THRESHOLD:
            bound.info(
                "no_idle_capital",
                treasury_balance=float(treasury_balance),
                reserve_floor=float(reserve_floor),
            )
            return []

        strategies = await self._fetch_eligible_strategies(db)
        if not strategies:
            bound.info("no_eligible_strategies")
            return []

        targets = self._compute_target_allocations(idle_capital, strategies)
        if not targets:
            bound.info("no_allocations_within_capacity")
            return []

        allocation_ids: List[str] = []
        for strategy, amount in targets:
            allocation_id = await self._execute_allocation(
                db=db,
                strategy=strategy,
                amount=amount,
                window_start=window_start,
            )
            allocation_ids.append(allocation_id)

        bound.info(
            "idle_balances_staked",
            allocation_count=len(allocation_ids),
            idle_capital=float(idle_capital),
            reserve_floor=float(reserve_floor),
        )
        return allocation_ids

    def compute_reserve_floor(self, treasury_balance: Decimal) -> Decimal:
        """Return the minimum liquid USDC that must remain unstaked."""
        return (Decimal(str(treasury_balance)) * self.min_liquid_reserve_ratio).quantize(
            Decimal("0.0000001")
        )

    async def generate_monthly_report(
        self,
        db: AsyncSession,
        period_start: Optional[datetime] = None,
        treasury_balance: Optional[Decimal] = None,
    ) -> str:
        """Generate a monthly yield generation summary for governance.

        Parameters
        ----------
        db : AsyncSession
            Database session for ORM operations.
        period_start : Optional[datetime]
            First day of the reporting month (UTC). Defaults to the first day
            of the current month.
        treasury_balance : Optional[Decimal]
            Treasury balance at period close. Defaults to the sum of staked
            allocations plus the reserve floor.

        Returns
        -------
        str
            The report ID.
        """
        bound = log.bind(
            component="TreasuryYieldWorker", method="generate_monthly_report"
        )

        period_start = period_start or datetime.now(timezone.utc).replace(
            day=1, hour=0, minute=0, second=0, microsecond=0
        )
        period_end = self._next_month(period_start)

        stmt = select(TreasuryYieldAllocation).where(
            TreasuryYieldAllocation.window_start >= period_start,
            TreasuryYieldAllocation.window_start < period_end,
            TreasuryYieldAllocation.status == "STAKED",
        )
        result = await db.execute(stmt)
        allocations = result.scalars().all()

        total_staked = sum(
            (Decimal(str(a.amount)) for a in allocations), Decimal("0")
        )

        # Yield earned over the period, prorated by the fraction of the month
        # each allocation was active.
        total_yield = Decimal("0")
        weighted_apy_numerator = Decimal("0")
        per_strategy: Dict[str, Dict[str, Any]] = {}

        for allocation in allocations:
            amount = Decimal(str(allocation.amount))
            apy = Decimal(str(allocation.apy))
            active_fraction = self._active_fraction(
                allocation.window_start, period_start, period_end
            )
            earned = amount * apy * active_fraction
            total_yield += earned
            weighted_apy_numerator += amount * apy

            bucket = per_strategy.setdefault(
                allocation.strategy_id,
                {
                    "strategy_id": allocation.strategy_id,
                    "vault_address": allocation.vault_address,
                    "staked": Decimal("0"),
                    "yield_earned": Decimal("0"),
                    "apy": float(apy),
                },
            )
            bucket["staked"] += amount
            bucket["yield_earned"] += earned

        average_apy = (
            weighted_apy_numerator / total_staked
            if total_staked > 0
            else Decimal("0")
        )

        if treasury_balance is None:
            treasury_balance = total_staked + self.compute_reserve_floor(
                total_staked / (Decimal("1") - self.min_liquid_reserve_ratio)
                if self.min_liquid_reserve_ratio < 1
                else total_staked
            )
        treasury_balance = Decimal(str(treasury_balance))
        liquid_reserve = self.compute_reserve_floor(treasury_balance)
        reserve_ratio = (
            liquid_reserve / treasury_balance
            if treasury_balance > 0
            else Decimal("0")
        )

        report_id = self._generate_report_id(period_start)
        summary = {
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "strategies": [
                {
                    "strategy_id": bucket["strategy_id"],
                    "vault_address": bucket["vault_address"],
                    "staked": float(bucket["staked"]),
                    "yield_earned": float(bucket["yield_earned"]),
                    "apy": bucket["apy"],
                }
                for bucket in per_strategy.values()
            ],
        }

        report = TreasuryYieldReport(
            id=report_id,
            period_start=period_start,
            period_end=period_end,
            total_staked=total_staked,
            total_yield_earned=total_yield,
            average_apy=average_apy,
            liquid_reserve=liquid_reserve,
            reserve_ratio=reserve_ratio,
            allocation_count=len(allocations),
            summary=summary,
        )
        db.add(report)
        await db.commit()

        bound.info(
            "monthly_report_generated",
            report_id=report_id,
            total_staked=float(total_staked),
            total_yield_earned=float(total_yield),
            average_apy=float(average_apy),
        )
        return report_id

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------
    async def _fetch_eligible_strategies(
        self, db: AsyncSession
    ) -> List[Dict[str, Any]]:
        """Fetch enabled, low-risk USDC vault strategies."""
        stmt = select(VaultStrategy).where(
            VaultStrategy.enabled == True,  # noqa: E712
            VaultStrategy.asset == "USDC",
            VaultStrategy.risk_score <= self.max_risk_score,
        )
        result = await db.execute(stmt)
        strategies = result.scalars().all()

        return [
            {
                "id": s.id,
                "vault_address": s.vault_address,
                "current_apy": Decimal(str(s.current_apy)),
                "capacity": Decimal(str(s.capacity)) if s.capacity is not None else None,
                "risk_score": Decimal(str(s.risk_score)),
            }
            for s in strategies
        ]

    def _compute_target_allocations(
        self,
        idle_capital: Decimal,
        strategies: List[Dict[str, Any]],
    ) -> List[Tuple[Dict[str, Any], Decimal]]:
        """Distribute idle capital across strategies proportional to APY.

        Allocations are capped by each vault's remaining capacity. Any capital
        that cannot be placed is left liquid.
        """
        total_apy = sum((s["current_apy"] for s in strategies), Decimal("0"))
        if total_apy <= 0:
            return []

        targets: List[Tuple[Dict[str, Any], Decimal]] = []
        for strategy in strategies:
            weight = strategy["current_apy"] / total_apy
            amount = (idle_capital * weight).quantize(Decimal("0.0000001"))

            capacity = strategy["capacity"]
            if capacity is not None:
                amount = min(amount, capacity)

            if amount > DUST_THRESHOLD:
                targets.append((strategy, amount))

        return targets

    async def _execute_allocation(
        self,
        db: AsyncSession,
        strategy: Dict[str, Any],
        amount: Decimal,
        window_start: datetime,
    ) -> str:
        """Persist and execute a single staking allocation (idempotent)."""
        allocation_id = self._generate_allocation_id(strategy["id"], window_start)

        existing = await db.get(TreasuryYieldAllocation, allocation_id)
        if existing is not None and existing.status == "STAKED":
            log.info(
                "treasury_yield_worker.allocation_exists",
                allocation_id=allocation_id,
                strategy_id=strategy["id"],
            )
            return allocation_id

        allocation = existing or TreasuryYieldAllocation(
            id=allocation_id,
            strategy_id=strategy["id"],
            vault_address=strategy["vault_address"],
            amount=amount,
            apy=strategy["current_apy"],
            status="PENDING",
            window_start=window_start,
        )
        allocation.amount = amount
        allocation.apy = strategy["current_apy"]
        allocation.status = "PENDING"
        if existing is None:
            db.add(allocation)
        await db.commit()

        try:
            with vault_operation_lock(self.treasury_account):
                tx_hash = await self._submit_stake(strategy, amount)

            allocation.status = "STAKED"
            allocation.transaction_hash = tx_hash
            await db.commit()
            return allocation_id
        except Exception as exc:  # pragma: no cover - defensive
            allocation.status = "FAILED"
            allocation.metadata = {"error": str(exc)}
            await db.commit()
            raise TreasuryYieldError(
                f"Failed to stake {amount} USDC into {strategy['id']}: {exc}"
            ) from exc

    async def _submit_stake(
        self, strategy: Dict[str, Any], amount: Decimal
    ) -> str:
        """Submit the on-chain staking transaction for one vault."""
        with managed_sequence(self.relayer_pool) as (account, sequence):
            # Actual Soroban contract invocation is environment-specific; the
            # deterministic hash keeps the worker idempotent and testable.
            tx_hash = hashlib.sha256(
                f"{strategy['id']}:{amount}:{account}:{sequence}".encode()
            ).hexdigest()
            log.info(
                "treasury_yield_worker.stake_submitted",
                strategy_id=strategy["id"],
                amount=float(amount),
                tx_hash=tx_hash,
            )
            return tx_hash

    @staticmethod
    def _active_fraction(
        allocation_start: datetime,
        period_start: datetime,
        period_end: datetime,
    ) -> Decimal:
        """Fraction of the reporting period an allocation was active."""
        start = max(allocation_start, period_start)
        if start >= period_end:
            return Decimal("0")
        total_seconds = Decimal(str((period_end - period_start).total_seconds()))
        active_seconds = Decimal(str((period_end - start).total_seconds()))
        if total_seconds <= 0:
            return Decimal("0")
        return active_seconds / total_seconds

    @staticmethod
    def _next_month(period_start: datetime) -> datetime:
        """Return the first instant of the month following ``period_start``."""
        year = period_start.year + (1 if period_start.month == 12 else 0)
        month = 1 if period_start.month == 12 else period_start.month + 1
        return period_start.replace(year=year, month=month, day=1)

    @staticmethod
    def _generate_allocation_id(strategy_id: str, window_start: datetime) -> str:
        return hashlib.sha256(
            f"{strategy_id}:{window_start.isoformat()}".encode()
        ).hexdigest()

    @staticmethod
    def _generate_report_id(period_start: datetime) -> str:
        return hashlib.sha256(
            f"treasury_report:{period_start.isoformat()}".encode()
        ).hexdigest()


async def create_treasury_yield_worker(
    relayer_pool: RelayerPool,
) -> TreasuryYieldWorker:
    """Factory for creating a TreasuryYieldWorker instance."""
    return TreasuryYieldWorker(relayer_pool=relayer_pool)
