"""app/services/capital_rebalancer.py — Automated capital rebalancing execution.

Orchestrates capital movements across vault strategies to align with target
allocations computed by the portfolio optimizer.
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_async_db
from app.models.allocation import (
    CapitalAllocation,
    RebalancingHistory,
    VaultStrategy,
)
from app.services.nonce_manager import RelayerPool, managed_sequence
from app.services.portfolio_optimizer import PortfolioOptimizer
from app.services.vault_operation_lock import vault_operation_lock

log = structlog.get_logger(__name__)


class RebalancingError(RuntimeError):
    """Raised when capital rebalancing fails."""


def build_rebalancing_instructions(
    strategies: List[Dict[str, Any]],
    current_allocations: Dict[str, Decimal],
    target_allocations: Dict[str, Decimal],
    total_capital: Decimal,
) -> List[Dict[str, Any]]:
    """Build ordered step-by-step transaction instructions for the harvest worker.

    Each instruction is self-contained so a worker can execute it without
    re-deriving anything: it names the target vault, the action to take
    (``WITHDRAW`` or ``DEPOSIT``), the absolute amount and the resulting target
    weight.  Instructions are ordered so every ``WITHDRAW`` leg precedes every
    ``DEPOSIT`` leg, which frees capital before it is redeployed and avoids a
    transient funding shortfall on the deposit legs.  Movements below the dust
    threshold (1e-4 of total capital) are omitted.
    """
    vault_by_strategy = {s["id"]: s.get("vault_address") for s in strategies}
    risk_by_strategy = {
        s["id"]: float(s.get("risk_score", 0.0)) for s in strategies
    }

    all_strategies = set(current_allocations.keys()) | set(target_allocations.keys())

    instructions: List[Dict[str, Any]] = []
    for strategy_id in sorted(all_strategies):
        current_weight = current_allocations.get(strategy_id, Decimal("0"))
        target_weight = target_allocations.get(strategy_id, Decimal("0"))
        delta_weight = target_weight - current_weight

        if abs(delta_weight) <= Decimal("0.0001"):  # Ignore dust
            continue

        delta_amount = delta_weight * total_capital
        direction = "INCREASE" if delta_amount > 0 else "DECREASE"

        instructions.append(
            {
                "strategy_id": strategy_id,
                "vault_address": vault_by_strategy.get(strategy_id),
                "risk_score": risk_by_strategy.get(strategy_id),
                "direction": direction,
                "action": "DEPOSIT" if direction == "INCREASE" else "WITHDRAW",
                "delta_weight": float(delta_weight),
                "delta_amount": float(delta_amount),
                "amount": abs(float(delta_amount)),
                "current_weight": float(current_weight),
                "target_weight": float(target_weight),
            }
        )

    # Withdrawals first so capital is available before the deposit legs run.
    instructions.sort(key=lambda m: (m["direction"] != "DECREASE", m["strategy_id"]))
    for step, instruction in enumerate(instructions, start=1):
        instruction["step"] = step

    return instructions


class CapitalRebalancer:
    """Orchestrates automated capital rebalancing across vault strategies.

    Parameters
    ----------
    optimizer : PortfolioOptimizer
        Portfolio optimizer instance for computing target allocations.
    relayer_pool : RelayerPool
        Relayer pool for transaction execution.
    drift_threshold : Decimal
        Minimum drift magnitude to trigger rebalancing (default: 0.05 = 5%).
    treasury_account : str
        Treasury account address managing capital.
    """

    def __init__(
        self,
        optimizer: PortfolioOptimizer,
        relayer_pool: Optional[RelayerPool] = None,
        drift_threshold: Decimal = Decimal("0.05"),
        treasury_account: Optional[str] = None,
    ) -> None:
        if not 0 < drift_threshold <= 1:
            raise ValueError("drift_threshold must be in (0, 1]")

        self.optimizer = optimizer
        self.relayer_pool = relayer_pool
        self.drift_threshold = drift_threshold
        self.treasury_account = treasury_account or os.getenv(
            "TREASURY_ACCOUNT", "GABC..."
        )

        log.info(
            "capital_rebalancer.initialized",
            component="CapitalRebalancer",
            drift_threshold=float(drift_threshold),
            treasury_account=self.treasury_account,
        )

    async def check_and_rebalance(
        self,
        db: AsyncSession,
    ) -> Optional[str]:
        """Check allocation drift and execute rebalancing if threshold exceeded.

        Parameters
        ----------
        db : AsyncSession
            Database session for ORM operations.

        Returns
        -------
        Optional[str]
            Rebalancing operation ID if executed, None if no rebalancing needed.

        Raises
        ------
        RebalancingError
            If rebalancing execution fails.
        """
        bound = log.bind(component="CapitalRebalancer", method="check_and_rebalance")

        # Fetch all strategies
        strategies = await self._fetch_strategies(db)
        if not strategies:
            bound.warning("no_strategies_found")
            return None

        # Compute total capital
        total_capital = await self._compute_total_capital(db)
        if total_capital <= 0:
            bound.warning("zero_total_capital")
            return None

        # Get current allocations
        current_allocations = await self._fetch_current_allocations(db)

        # Compute target allocations
        target_allocations, metrics = self.optimizer.compute_target_allocations(
            strategies, total_capital
        )

        # Check drift
        max_drift, drifts = self.optimizer.check_drift(
            current_allocations, target_allocations
        )

        bound.info(
            "drift_computed",
            max_drift=float(max_drift),
            threshold=float(self.drift_threshold),
            expected_apy=metrics.get("expected_apy"),
        )

        # Execute rebalancing if drift exceeds threshold
        if max_drift > self.drift_threshold:
            rebalancing_id = await self._execute_rebalancing(
                db=db,
                strategies=strategies,
                current_allocations=current_allocations,
                target_allocations=target_allocations,
                total_capital=total_capital,
                max_drift=max_drift,
                metrics=metrics,
            )
            bound.info("rebalancing_triggered", rebalancing_id=rebalancing_id)
            return rebalancing_id
        else:
            bound.info("no_rebalancing_needed", max_drift=float(max_drift))
            return None

    async def plan_rebalancing(self, db: AsyncSession) -> Dict[str, Any]:
        """Compute target allocations and ordered instructions *without* executing.

        Read-only counterpart to :meth:`check_and_rebalance`.  It returns the
        step-by-step transaction instructions the auto-harvest worker must run,
        so the exact re-allocation can be inspected (or handed off) before any
        capital moves on-chain.

        Returns
        -------
        Dict[str, Any]
            Plan with ``rebalancing_needed``, current/target weights, maximum
            drift and an ordered ``instructions`` list.
        """
        bound = log.bind(component="CapitalRebalancer", method="plan_rebalancing")

        strategies = await self._fetch_strategies(db)
        if not strategies:
            bound.warning("no_strategies_found")
            return self._empty_plan("No enabled strategies found")

        total_capital = await self._compute_total_capital(db)
        if total_capital <= 0:
            bound.warning("zero_total_capital")
            return self._empty_plan("Zero total capital under management")

        current_allocations = await self._fetch_current_allocations(db)

        target_allocations, metrics = self.optimizer.compute_target_allocations(
            strategies, total_capital
        )
        max_drift, _ = self.optimizer.check_drift(
            current_allocations, target_allocations
        )

        instructions = build_rebalancing_instructions(
            strategies, current_allocations, target_allocations, total_capital
        )
        rebalancing_needed = max_drift > self.drift_threshold

        bound.info(
            "rebalancing_plan_computed",
            max_drift=float(max_drift),
            instruction_count=len(instructions),
            rebalancing_needed=rebalancing_needed,
        )

        return {
            "rebalancing_needed": rebalancing_needed,
            "total_capital": float(total_capital),
            "max_drift": float(max_drift),
            "drift_threshold": float(self.drift_threshold),
            "current_allocations": {
                k: float(v) for k, v in current_allocations.items()
            },
            "target_allocations": {
                k: float(v) for k, v in target_allocations.items()
            },
            "instructions": instructions,
            "metrics": metrics,
            "message": (
                "Rebalancing required"
                if rebalancing_needed
                else "Allocation drift within threshold"
            ),
        }

    def _empty_plan(self, message: str) -> Dict[str, Any]:
        """Return an empty plan payload for the no-work cases."""
        return {
            "rebalancing_needed": False,
            "total_capital": 0.0,
            "max_drift": 0.0,
            "drift_threshold": float(self.drift_threshold),
            "current_allocations": {},
            "target_allocations": {},
            "instructions": [],
            "metrics": {},
            "message": message,
        }

    async def _fetch_strategies(self, db: AsyncSession) -> List[Dict[str, Any]]:
        """Fetch all enabled vault strategies."""
        stmt = select(VaultStrategy).where(VaultStrategy.enabled == True)
        result = await db.execute(stmt)
        strategies = result.scalars().all()

        return [
            {
                "id": s.id,
                "vault_address": s.vault_address,
                "current_apy": float(s.current_apy),
                "historical_apy_std": float(s.historical_apy_std or 0.01),
                "tvl": float(s.tvl),
                "capacity": float(s.capacity) if s.capacity else None,
                "risk_score": float(s.risk_score),
                "enabled": s.enabled,
            }
            for s in strategies
        ]

    async def _compute_total_capital(self, db: AsyncSession) -> Decimal:
        """Compute total capital under management."""
        stmt = select(CapitalAllocation)
        result = await db.execute(stmt)
        allocations = result.scalars().all()

        total = sum(a.allocated_amount for a in allocations)
        return Decimal(str(total))

    async def _fetch_current_allocations(
        self, db: AsyncSession
    ) -> Dict[str, Decimal]:
        """Fetch current allocation weights."""
        stmt = select(CapitalAllocation)
        result = await db.execute(stmt)
        allocations = result.scalars().all()

        return {a.strategy_id: Decimal(str(a.current_weight)) for a in allocations}

    async def _execute_rebalancing(
        self,
        db: AsyncSession,
        strategies: List[Dict[str, Any]],
        current_allocations: Dict[str, Decimal],
        target_allocations: Dict[str, Decimal],
        total_capital: Decimal,
        max_drift: Decimal,
        metrics: Dict[str, Any],
    ) -> str:
        """Execute capital rebalancing operation."""
        bound = log.bind(component="CapitalRebalancer", method="_execute_rebalancing")

        # Generate rebalancing ID
        rebalancing_id = self._generate_rebalancing_id()

        # Compute the ordered, executable capital movements/instructions
        movements = self._compute_movements(
            current_allocations, target_allocations, total_capital, strategies
        )

        # Compute aggregate APY before rebalancing
        apy_before = self._compute_aggregate_apy(strategies, current_allocations)

        # Create rebalancing history record
        history = RebalancingHistory(
            id=rebalancing_id,
            triggered_at=datetime.now(timezone.utc),
            status="IN_PROGRESS",
            total_capital=total_capital,
            drift_magnitude=max_drift,
            target_allocations={k: float(v) for k, v in target_allocations.items()},
            previous_allocations={k: float(v) for k, v in current_allocations.items()},
            movements=movements,
            aggregate_apy_before=Decimal(str(apy_before)),
            metadata=metrics,
        )
        db.add(history)
        await db.commit()

        bound.info(
            "rebalancing_started",
            rebalancing_id=rebalancing_id,
            movements_count=len(movements),
        )

        # Execute on-chain transactions
        transaction_hashes = []
        execution_cost = Decimal("0")

        try:
            with vault_operation_lock(self.treasury_account):
                for movement in movements:
                    tx_hash, cost = await self._execute_movement(movement)
                    transaction_hashes.append(tx_hash)
                    execution_cost += cost
                    bound.debug("movement_executed", tx_hash=tx_hash, cost=float(cost))

            # Update capital allocations in database
            await self._update_allocations(db, target_allocations, total_capital)

            # Compute aggregate APY after rebalancing
            apy_after = self._compute_aggregate_apy(strategies, target_allocations)

            # Mark rebalancing as completed
            history.status = "COMPLETED"
            history.completed_at = datetime.now(timezone.utc)
            history.transaction_hashes = transaction_hashes
            history.execution_cost = execution_cost
            history.aggregate_apy_after = Decimal(str(apy_after))
            await db.commit()

            bound.info(
                "rebalancing_completed",
                rebalancing_id=rebalancing_id,
                tx_count=len(transaction_hashes),
                apy_improvement=float(apy_after - apy_before),
            )

            return rebalancing_id

        except Exception as exc:
            bound.exception("rebalancing_failed", error=str(exc))
            history.status = "FAILED"
            history.error_message = str(exc)
            await db.commit()
            raise RebalancingError(f"Rebalancing failed: {exc}") from exc

    def _generate_rebalancing_id(self) -> str:
        """Generate unique rebalancing operation ID."""
        timestamp = datetime.now(timezone.utc).isoformat()
        hash_input = f"rebalancing:{timestamp}:{os.urandom(8).hex()}"
        return hashlib.sha256(hash_input.encode()).hexdigest()

    def _compute_movements(
        self,
        current_allocations: Dict[str, Decimal],
        target_allocations: Dict[str, Decimal],
        total_capital: Decimal,
        strategies: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        """Compute ordered capital movements needed to reach target allocations.

        Thin wrapper around :func:`build_rebalancing_instructions`; ``strategies``
        is optional so the pure movement math can be exercised without vault
        metadata.
        """
        return build_rebalancing_instructions(
            strategies or [],
            current_allocations,
            target_allocations,
            total_capital,
        )

    async def _execute_movement(
        self, movement: Dict[str, Any]
    ) -> Tuple[str, Decimal]:
        """Execute a single capital movement on-chain.

        Parameters
        ----------
        movement : Dict[str, Any]
            Movement specification with strategy_id, delta_amount, direction.

        Returns
        -------
        Tuple[str, Decimal]
            (transaction_hash, execution_cost)
        """
        strategy_id = movement["strategy_id"]
        delta_amount = movement["delta_amount"]
        direction = movement["direction"]

        bound = log.bind(
            component="CapitalRebalancer",
            strategy_id=strategy_id,
            delta_amount=delta_amount,
            direction=direction,
        )

        # Acquire relayer account and sequence
        with managed_sequence(self.relayer_pool) as (account, sequence):
            # Build transaction (pseudo-code - actual implementation depends on Soroban contract)
            # tx = build_vault_deposit_or_withdraw_tx(
            #     vault_address=vault_address,
            #     amount=abs(delta_amount),
            #     operation=direction,
            #     source_account=account,
            #     sequence=sequence,
            # )
            # tx_hash = await submit_transaction(tx)

            # Mock transaction submission for now
            tx_hash = hashlib.sha256(
                f"{strategy_id}:{delta_amount}:{account}:{sequence}".encode()
            ).hexdigest()
            execution_cost = Decimal("0.01")  # Mock gas cost

            bound.info("movement_tx_submitted", tx_hash=tx_hash)

            return tx_hash, execution_cost

    async def _update_allocations(
        self,
        db: AsyncSession,
        target_allocations: Dict[str, Decimal],
        total_capital: Decimal,
    ) -> None:
        """Update capital_allocation table with new target weights and amounts."""
        for strategy_id, target_weight in target_allocations.items():
            allocated_amount = target_weight * total_capital

            # Upsert allocation record
            stmt = select(CapitalAllocation).where(
                CapitalAllocation.strategy_id == strategy_id
            )
            result = await db.execute(stmt)
            allocation = result.scalar_one_or_none()

            if allocation:
                allocation.target_weight = target_weight
                allocation.current_weight = target_weight
                allocation.allocated_amount = allocated_amount
                allocation.last_rebalance = datetime.now(timezone.utc)
            else:
                allocation = CapitalAllocation(
                    id=self._generate_allocation_id(strategy_id),
                    strategy_id=strategy_id,
                    allocated_amount=allocated_amount,
                    target_weight=target_weight,
                    current_weight=target_weight,
                    last_rebalance=datetime.now(timezone.utc),
                )
                db.add(allocation)

        await db.commit()

    def _generate_allocation_id(self, strategy_id: str) -> str:
        """Generate allocation record ID."""
        return hashlib.sha256(f"allocation:{strategy_id}".encode()).hexdigest()[:16]

    def _compute_aggregate_apy(
        self,
        strategies: List[Dict[str, Any]],
        allocations: Dict[str, Decimal],
    ) -> float:
        """Compute portfolio-weighted aggregate APY."""
        strategy_apy_map = {s["id"]: s["current_apy"] for s in strategies}

        weighted_apy = sum(
            float(allocations.get(strategy_id, Decimal("0")))
            * strategy_apy_map.get(strategy_id, 0.0)
            for strategy_id in allocations.keys()
        )

        return weighted_apy


async def create_capital_rebalancer(
    optimizer: PortfolioOptimizer,
    relayer_pool: Optional[RelayerPool] = None,
) -> CapitalRebalancer:
    """Factory for creating CapitalRebalancer instance.

    Parameters
    ----------
    optimizer : PortfolioOptimizer
        Portfolio optimizer instance.
    relayer_pool : Optional[RelayerPool]
        Relayer pool for transaction execution.  May be omitted for read-only
        planning (``plan_rebalancing``), which never submits transactions.

    Returns
    -------
    CapitalRebalancer
        Configured rebalancer instance.
    """
    drift_threshold = Decimal(os.getenv("REBALANCING_DRIFT_THRESHOLD", "0.05"))
    treasury_account = os.getenv("TREASURY_ACCOUNT")

    return CapitalRebalancer(
        optimizer=optimizer,
        relayer_pool=relayer_pool,
        drift_threshold=drift_threshold,
        treasury_account=treasury_account,
    )
