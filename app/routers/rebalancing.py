"""FastAPI router for capital rebalancing and allocation endpoints."""

from __future__ import annotations

import os
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_async_db
from app.models.allocation import (
    CapitalAllocation,
    RebalancingHistory,
    VaultStrategy,
)
from app.services.capital_rebalancer import create_capital_rebalancer
from app.services.nonce_manager import create_relayer_pool
from app.services.portfolio_optimizer import create_portfolio_optimizer

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/rebalancing", tags=["Rebalancing"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class VaultStrategyResponse(BaseModel):
    id: str
    vault_address: str
    strategy_type: str
    asset: str
    current_apy: float
    historical_apy_mean: Optional[float] = None
    historical_apy_std: Optional[float] = None
    tvl: float
    capacity: Optional[float] = None
    risk_score: float
    enabled: bool
    last_apy_update: datetime
    created_at: datetime


class CapitalAllocationResponse(BaseModel):
    id: str
    strategy_id: str
    allocated_amount: float
    target_weight: float
    current_weight: float
    last_rebalance: Optional[datetime] = None
    updated_at: datetime


class RebalancingHistoryResponse(BaseModel):
    id: str
    triggered_at: datetime
    completed_at: Optional[datetime] = None
    status: str
    total_capital: float
    drift_magnitude: float
    target_allocations: Dict[str, float]
    previous_allocations: Dict[str, float]
    movements: Optional[List[Dict[str, Any]]] = None
    transaction_hashes: Optional[List[str]] = None
    aggregate_apy_before: Optional[float] = None
    aggregate_apy_after: Optional[float] = None
    execution_cost: Optional[float] = None
    error_message: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    created_at: datetime


class TriggerRebalancingRequest(BaseModel):
    force: bool = Field(
        default=False, description="Force rebalancing even if drift below threshold"
    )


class TriggerRebalancingResponse(BaseModel):
    success: bool
    rebalancing_id: Optional[str] = None
    message: str


class AllocationDriftResponse(BaseModel):
    max_drift: float
    drift_threshold: float
    rebalancing_needed: bool
    drift_per_strategy: Dict[str, float]
    current_allocations: Dict[str, float]
    target_allocations: Dict[str, float]


class RebalancingInstruction(BaseModel):
    step: int
    action: str
    direction: str
    strategy_id: str
    vault_address: Optional[str] = None
    risk_score: Optional[float] = None
    amount: float
    delta_amount: float
    delta_weight: float
    current_weight: float
    target_weight: float


class RebalancingPlanResponse(BaseModel):
    rebalancing_needed: bool
    total_capital: float
    max_drift: float
    drift_threshold: float
    current_allocations: Dict[str, float]
    target_allocations: Dict[str, float]
    instructions: List[RebalancingInstruction]
    expected_apy: Optional[float] = None
    capital_deployed_fraction: Optional[float] = None
    portfolio_risk_score: Optional[float] = None
    message: str


class CreateStrategyRequest(BaseModel):
    id: str
    vault_address: str
    strategy_type: str
    asset: str
    current_apy: float
    historical_apy_mean: Optional[float] = None
    historical_apy_std: Optional[float] = None
    tvl: float
    capacity: Optional[float] = None
    risk_score: float = Field(ge=0.0, le=1.0)
    enabled: bool = True
    metadata: Optional[Dict[str, Any]] = None


class UpdateAPYRequest(BaseModel):
    strategy_id: str
    current_apy: float


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/strategies", response_model=List[VaultStrategyResponse])
async def list_strategies(
    enabled_only: bool = False,
    db: AsyncSession = Depends(get_async_db),
) -> List[VaultStrategyResponse]:
    """List all vault strategies."""
    bound = log.bind(endpoint="list_strategies", enabled_only=enabled_only)

    try:
        if enabled_only:
            stmt = select(VaultStrategy).where(VaultStrategy.enabled == True)
        else:
            stmt = select(VaultStrategy)

        result = await db.execute(stmt)
        strategies = result.scalars().all()

        bound.info("strategies_listed", count=len(strategies))

        return [
            VaultStrategyResponse(
                id=s.id,
                vault_address=s.vault_address,
                strategy_type=s.strategy_type,
                asset=s.asset,
                current_apy=float(s.current_apy),
                historical_apy_mean=(
                    float(s.historical_apy_mean) if s.historical_apy_mean else None
                ),
                historical_apy_std=(
                    float(s.historical_apy_std) if s.historical_apy_std else None
                ),
                tvl=float(s.tvl),
                capacity=float(s.capacity) if s.capacity else None,
                risk_score=float(s.risk_score),
                enabled=s.enabled,
                last_apy_update=s.last_apy_update,
                created_at=s.created_at,
            )
            for s in strategies
        ]
    except Exception as exc:
        bound.exception("list_strategies_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/strategies", response_model=VaultStrategyResponse, status_code=201)
async def create_strategy(
    request: CreateStrategyRequest,
    db: AsyncSession = Depends(get_async_db),
) -> VaultStrategyResponse:
    """Register a new vault strategy."""
    bound = log.bind(endpoint="create_strategy", strategy_id=request.id)

    try:
        # Check if strategy already exists
        stmt = select(VaultStrategy).where(VaultStrategy.id == request.id)
        result = await db.execute(stmt)
        existing = result.scalar_one_or_none()

        if existing:
            raise HTTPException(
                status_code=409, detail=f"Strategy {request.id} already exists"
            )

        strategy = VaultStrategy(
            id=request.id,
            vault_address=request.vault_address,
            strategy_type=request.strategy_type,
            asset=request.asset,
            current_apy=Decimal(str(request.current_apy)),
            historical_apy_mean=(
                Decimal(str(request.historical_apy_mean))
                if request.historical_apy_mean is not None
                else None
            ),
            historical_apy_std=(
                Decimal(str(request.historical_apy_std))
                if request.historical_apy_std is not None
                else None
            ),
            tvl=Decimal(str(request.tvl)),
            capacity=(
                Decimal(str(request.capacity)) if request.capacity is not None else None
            ),
            risk_score=Decimal(str(request.risk_score)),
            enabled=request.enabled,
            metadata=request.metadata,
        )

        db.add(strategy)
        await db.commit()
        await db.refresh(strategy)

        bound.info("strategy_created", strategy_id=strategy.id)

        return VaultStrategyResponse(
            id=strategy.id,
            vault_address=strategy.vault_address,
            strategy_type=strategy.strategy_type,
            asset=strategy.asset,
            current_apy=float(strategy.current_apy),
            historical_apy_mean=(
                float(strategy.historical_apy_mean)
                if strategy.historical_apy_mean
                else None
            ),
            historical_apy_std=(
                float(strategy.historical_apy_std) if strategy.historical_apy_std else None
            ),
            tvl=float(strategy.tvl),
            capacity=float(strategy.capacity) if strategy.capacity else None,
            risk_score=float(strategy.risk_score),
            enabled=strategy.enabled,
            last_apy_update=strategy.last_apy_update,
            created_at=strategy.created_at,
        )
    except HTTPException:
        raise
    except Exception as exc:
        bound.exception("create_strategy_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/strategies/update-apy")
async def update_strategy_apy(
    request: UpdateAPYRequest,
    db: AsyncSession = Depends(get_async_db),
) -> Dict[str, Any]:
    """Update a strategy's current APY."""
    bound = log.bind(endpoint="update_strategy_apy", strategy_id=request.strategy_id)

    try:
        stmt = select(VaultStrategy).where(VaultStrategy.id == request.strategy_id)
        result = await db.execute(stmt)
        strategy = result.scalar_one_or_none()

        if not strategy:
            raise HTTPException(
                status_code=404, detail=f"Strategy {request.strategy_id} not found"
            )

        strategy.current_apy = Decimal(str(request.current_apy))
        strategy.last_apy_update = datetime.utcnow()
        await db.commit()

        bound.info("apy_updated", new_apy=request.current_apy)

        return {"success": True, "strategy_id": request.strategy_id, "apy": request.current_apy}
    except HTTPException:
        raise
    except Exception as exc:
        bound.exception("update_apy_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/allocations", response_model=List[CapitalAllocationResponse])
async def list_allocations(
    db: AsyncSession = Depends(get_async_db),
) -> List[CapitalAllocationResponse]:
    """List current capital allocations."""
    bound = log.bind(endpoint="list_allocations")

    try:
        stmt = select(CapitalAllocation)
        result = await db.execute(stmt)
        allocations = result.scalars().all()

        bound.info("allocations_listed", count=len(allocations))

        return [
            CapitalAllocationResponse(
                id=a.id,
                strategy_id=a.strategy_id,
                allocated_amount=float(a.allocated_amount),
                target_weight=float(a.target_weight),
                current_weight=float(a.current_weight),
                last_rebalance=a.last_rebalance,
                updated_at=a.updated_at,
            )
            for a in allocations
        ]
    except Exception as exc:
        bound.exception("list_allocations_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/drift", response_model=AllocationDriftResponse)
async def check_allocation_drift(
    db: AsyncSession = Depends(get_async_db),
) -> AllocationDriftResponse:
    """Check current allocation drift without executing rebalancing."""
    bound = log.bind(endpoint="check_allocation_drift")

    try:
        optimizer = create_portfolio_optimizer()
        drift_threshold = Decimal(os.getenv("REBALANCING_DRIFT_THRESHOLD", "0.05"))

        # Fetch strategies and allocations
        strategies_stmt = select(VaultStrategy).where(VaultStrategy.enabled == True)
        strategies_result = await db.execute(strategies_stmt)
        strategies = strategies_result.scalars().all()

        allocations_stmt = select(CapitalAllocation)
        allocations_result = await db.execute(allocations_stmt)
        allocations = allocations_result.scalars().all()

        if not strategies:
            raise HTTPException(status_code=404, detail="No enabled strategies found")

        # Compute total capital
        total_capital = sum(a.allocated_amount for a in allocations)

        # Get current allocations
        current_allocations = {
            a.strategy_id: Decimal(str(a.current_weight)) for a in allocations
        }

        # Compute target allocations
        strategy_dicts = [
            {
                "id": s.id,
                "current_apy": float(s.current_apy),
                "historical_apy_std": float(s.historical_apy_std or 0.01),
                "tvl": float(s.tvl),
                "capacity": float(s.capacity) if s.capacity else None,
                "risk_score": float(s.risk_score),
                "enabled": s.enabled,
            }
            for s in strategies
        ]

        target_allocations, metrics = optimizer.compute_target_allocations(
            strategy_dicts, Decimal(str(total_capital))
        )

        # Compute drift
        max_drift, drifts = optimizer.check_drift(current_allocations, target_allocations)

        bound.info("drift_checked", max_drift=float(max_drift), threshold=float(drift_threshold))

        return AllocationDriftResponse(
            max_drift=float(max_drift),
            drift_threshold=float(drift_threshold),
            rebalancing_needed=max_drift > drift_threshold,
            drift_per_strategy={k: float(v) for k, v in drifts.items()},
            current_allocations={k: float(v) for k, v in current_allocations.items()},
            target_allocations={k: float(v) for k, v in target_allocations.items()},
        )
    except HTTPException:
        raise
    except Exception as exc:
        bound.exception("check_drift_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/plan", response_model=RebalancingPlanResponse)
async def plan_rebalancing(
    db: AsyncSession = Depends(get_async_db),
) -> RebalancingPlanResponse:
    """Preview the ordered re-allocation instructions without executing them.

    Returns the same target vector the automatic 6-hourly re-evaluation would
    compute, together with the step-by-step ``WITHDRAW``/``DEPOSIT`` instructions
    handed to the auto-harvest worker.  No capital is moved.
    """
    bound = log.bind(endpoint="plan_rebalancing")

    try:
        optimizer = create_portfolio_optimizer()
        rebalancer = await create_capital_rebalancer(optimizer)
        plan = await rebalancer.plan_rebalancing(db)
        metrics = plan.get("metrics") or {}

        bound.info(
            "rebalancing_plan_retrieved",
            rebalancing_needed=plan["rebalancing_needed"],
            instruction_count=len(plan["instructions"]),
        )

        return RebalancingPlanResponse(
            rebalancing_needed=plan["rebalancing_needed"],
            total_capital=plan["total_capital"],
            max_drift=plan["max_drift"],
            drift_threshold=plan["drift_threshold"],
            current_allocations=plan["current_allocations"],
            target_allocations=plan["target_allocations"],
            instructions=[
                RebalancingInstruction(**instruction)
                for instruction in plan["instructions"]
            ],
            expected_apy=metrics.get("expected_apy"),
            capital_deployed_fraction=metrics.get("capital_deployed_fraction"),
            portfolio_risk_score=metrics.get("portfolio_risk_score"),
            message=plan["message"],
        )
    except HTTPException:
        raise
    except Exception as exc:
        bound.exception("plan_rebalancing_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/trigger", response_model=TriggerRebalancingResponse)
async def trigger_rebalancing(
    request: TriggerRebalancingRequest = TriggerRebalancingRequest(),
    db: AsyncSession = Depends(get_async_db),
) -> TriggerRebalancingResponse:
    """Manually trigger capital rebalancing operation."""
    bound = log.bind(endpoint="trigger_rebalancing", force=request.force)

    try:
        optimizer = create_portfolio_optimizer()
        relayer_pool = create_relayer_pool()
        rebalancer = await create_capital_rebalancer(optimizer, relayer_pool)

        rebalancing_id = await rebalancer.check_and_rebalance(db)

        if rebalancing_id:
            bound.info("rebalancing_triggered", rebalancing_id=rebalancing_id)
            return TriggerRebalancingResponse(
                success=True,
                rebalancing_id=rebalancing_id,
                message="Rebalancing operation initiated successfully",
            )
        else:
            bound.info("no_rebalancing_needed")
            return TriggerRebalancingResponse(
                success=False,
                rebalancing_id=None,
                message="Allocation drift below threshold; no rebalancing needed",
            )
    except Exception as exc:
        bound.exception("trigger_rebalancing_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/history", response_model=List[RebalancingHistoryResponse])
async def list_rebalancing_history(
    limit: int = Field(default=50, ge=1, le=500),
    offset: int = Field(default=0, ge=0),
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_async_db),
) -> List[RebalancingHistoryResponse]:
    """List historical rebalancing operations."""
    bound = log.bind(endpoint="list_rebalancing_history", limit=limit, offset=offset, status=status)

    try:
        stmt = select(RebalancingHistory).order_by(RebalancingHistory.triggered_at.desc())

        if status:
            stmt = stmt.where(RebalancingHistory.status == status)

        stmt = stmt.limit(limit).offset(offset)

        result = await db.execute(stmt)
        history_records = result.scalars().all()

        bound.info("history_listed", count=len(history_records))

        return [
            RebalancingHistoryResponse(
                id=h.id,
                triggered_at=h.triggered_at,
                completed_at=h.completed_at,
                status=h.status,
                total_capital=float(h.total_capital),
                drift_magnitude=float(h.drift_magnitude),
                target_allocations=h.target_allocations,
                previous_allocations=h.previous_allocations,
                movements=h.movements,
                transaction_hashes=h.transaction_hashes,
                aggregate_apy_before=(
                    float(h.aggregate_apy_before) if h.aggregate_apy_before else None
                ),
                aggregate_apy_after=(
                    float(h.aggregate_apy_after) if h.aggregate_apy_after else None
                ),
                execution_cost=float(h.execution_cost) if h.execution_cost else None,
                error_message=h.error_message,
                metadata=h.metadata,
                created_at=h.created_at,
            )
            for h in history_records
        ]
    except Exception as exc:
        bound.exception("list_history_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/history/{rebalancing_id}", response_model=RebalancingHistoryResponse)
async def get_rebalancing_details(
    rebalancing_id: str,
    db: AsyncSession = Depends(get_async_db),
) -> RebalancingHistoryResponse:
    """Get details of a specific rebalancing operation."""
    bound = log.bind(endpoint="get_rebalancing_details", rebalancing_id=rebalancing_id)

    try:
        stmt = select(RebalancingHistory).where(RebalancingHistory.id == rebalancing_id)
        result = await db.execute(stmt)
        history = result.scalar_one_or_none()

        if not history:
            raise HTTPException(status_code=404, detail=f"Rebalancing {rebalancing_id} not found")

        bound.info("rebalancing_details_retrieved")

        return RebalancingHistoryResponse(
            id=history.id,
            triggered_at=history.triggered_at,
            completed_at=history.completed_at,
            status=history.status,
            total_capital=float(history.total_capital),
            drift_magnitude=float(history.drift_magnitude),
            target_allocations=history.target_allocations,
            previous_allocations=history.previous_allocations,
            movements=history.movements,
            transaction_hashes=history.transaction_hashes,
            aggregate_apy_before=(
                float(history.aggregate_apy_before) if history.aggregate_apy_before else None
            ),
            aggregate_apy_after=(
                float(history.aggregate_apy_after) if history.aggregate_apy_after else None
            ),
            execution_cost=float(history.execution_cost) if history.execution_cost else None,
            error_message=history.error_message,
            metadata=history.metadata,
            created_at=history.created_at,
        )
    except HTTPException:
        raise
    except Exception as exc:
        bound.exception("get_details_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
