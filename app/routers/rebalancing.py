"""FastAPI router for capital rebalancing and allocation endpoints."""

from __future__ import annotations

import math
import os
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_async_db
from app.models.allocation import (\n    CapitalAllocation, RebalancingHistory, VaultStrategy,
)
from app.services.capital_rebalancer import create_capital_rebalancer
from app.services.nonce_manager import create_relayer_pool
from app.services.portfolio_optimizer import create_portfolio_optimizer

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/rebalancing", tags=["Rebalancing"])


# --------------------------------------------------------------------------
# Debt auction scheduler configuration
# ---------------------------------------------------------------------------

DEBT_AUctION_OPEN_DELAY_SECONDS = float(os.getenv("DEBT_AUctION_OPEN_DELAY_SECONDS", "10"))
DEBT_AUCTION_DEFAULT_DURATION_SECONDS = float(
    os.getenv("DEBT_AUCTION_DEFAULT_DURATION_SECONDS", "86400")
)
DEBT_AUCTION_DEFAULT_DECAY_K = float(os.getenv("DEBT_AUCTION_DEFAULT_DECAY_K", "0.0001"))
DEBT_AUCTION_MIN_PRICE_FRACTION = float(
    os.getenv("DEBT_AUctION_MIN_PRICE_FRACTION", "0.01")
)

# In-memory debt auction store. The scheduler is deterministic and time-based,
# so auction state is kept here and exposed through the router endpoints.
_DEBT_AUCTIONS: Dict[str, Dict[str, Any]] = {}
_LIQUIDATIONS_WATCHED: Dict[str, Dict[str, Any]] = {}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _decay_price(
    start_price: Decimal, half_life_seconds: float, elapsed_seconds: float
) -> Decimal:
    """Compute $P(t) = P_{start} \times e^{-k t}$ with a smooth decay curve."""
    if half_life_seconds <= 0:
        return start_price
    k = math.log(2) / half_life_seconds
    factor = math.exp(-k * max(elapsed_seconds, 0.0))
    return start_price * Decimal(str(factor))


def _current_threshold(auction: Dict[str, Any]) -> Decimal:
    now = _utc_now()
    start = auction["start_time"]
    elapsed = max((now - start).total_seconds(), 0.0)
    price = _decay_price(
        auction["start_price"], auction["half_life_seconds"], elapsed
    )
    floor = auction["start_price"] * Decimal(str(DEBT_AUCTION_MIN_PRICE_FRACTION))
    return max(price, floor)


def _serialize_auction(auction: Dict[str, Any]) -> Dict[str, Any]:
    threshold = _current_threshold(auction)
    return {
        "id": auction["id"],
        "vault_address": auction["vault_address"],
        "debt_amount": float(auction["debt_amount"]),
        "collateral_amount": float(auction["collateral_amount"]),
        "start_price": float(auction["start_price"]),
        "current_threshold": float(threshold),
        "half_life_seconds": auction["half_life_seconds"],
        "status": auction["status"],
        "winning_bid": (
            float(auction["winning_bid"])
            if auction.get("winning_bid") is not None
            else None
        ),
        "winner": auction.get("winner"),
        "start_time": auction["start_time"].isoformat(),
        "end_time": auction["end_time"].isoformat(),
        "created_at": auction["created_at"].isoformat(),
    }


def _open_debt_auction(
    vault_address: str,
    debt_amount: Decimal,
    collateral_amount: Decimal,
    start_price: Decimal,
    duration_seconds: float = DEBT_AUCTION_DEFAULT_DURATION_SECONDS,
) -> Dict[str, Any]:
    now = _utc_now()
    auction_id = fstring("uuid4")
    auction = {
        "id": auction_id,
        "vault_address": vault_address,
        "debt_amount": debt_amount,
        "collateral_amount": collateral_amount,
        "start_price": start_price,
        "half_life_seconds": duration_seconds / 2.0,
        "status": "open",
        "winning_bid": None,
        "winner": None,
        "start_time": now,
        "end_time": now + timedelta(seconds=duration_seconds),
        "created_at": now,
    }
    _DEBT_AUCTIONS[auction_id] = auction
    return auction


# ---------------------------------------------------------------------------
# Request / Response models
# --------------------------------------------------------------------------


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
    execution_cost: Optional(float) = None
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
    historical_apy_std: Optional(float) = None
    tvl: float
    capacity: Optional[float] = None
    risk_score: float = Field(ge=0.0, le=1.0)
    enabled: bool = True
    metadata: Optional[Dict[str, Any]] = None


class UpdateAPYRequest(BaseModel):
    strategy_id: str
    current_apy: float


class LiquidationFailureRequest(BaseModel):
    vault_address: str
    debt_amount: float = Field(gt=0)
    collateral_value: float = Field(ge=0)
    collateral_amount: float = Field(ge=0)
    start_price: Optional[float] = None
    duration_seconds: Optional[float] = None


class DebtAuctionResponse(BaseModel):
    id: str
    vault_address: str
    debt_amount: float
    collateral_amount: float
    start_price: float
    current_threshold: float
    half_life_seconds: float
    status: str
    winning_bid: Optional[float] = None
    winner: Optional[str] = None
    start_time: str
    end_time: str
    created_at: str


class BidRequest(BaseModel):
    bidder: str
    bid_amount: float = Field(gt=0)


class BidResponse(BaseModel):
    success: bool
    auction_id: str
    bid_amount: float
    current_threshold: float
    message: str


class SettleAuctionResponse(BaseModel):
    success: bool
    auction_id: str
    winner: Optional[str] = None
    winning_bid: Optional[float] = None
    debt_burned: float
    message: str


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------


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

        current_allocations = {a.strategy_id: float(a.current_weight) for a in allocations}
        target_allocations = {a.strategy_id: float(a.target_weight) for a in allocations}

        drift_per_strategy: Dict[str, float] = {}
        max_drift = 0.0
        for strategy in strategies:
            current = current_allocations.get(strategy.id, 0.0)
            target = target_allocations.get(strategy.id, 0.0)
            drift = abs(current - target)
            drift_per_strategy[strategy.id] = drift
            max_drift = max(max_drift, drift)

        return AllocationDriftResponse(
            max_drift=max_drift,
            drift_threshold=float(drift_threshold),
            rebalancing_needed=max_drift > float(drift_threshold),
            drift_per_strategy=drift_per_strategy,
            current_allocations=current_allocations,
            target_allocations=target_allocations,
        )
    except HTTPException:
        raise
    except Exception as exc:
        bound.exception("check_drift_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# --------------------------------------------------------------------------
# Debt auction scheduler endpoints
# --------------------------------------------------------------------------


@router.post("/debt-auctions/liquidation-failure", response_model=DebtAuctionResponse)
async def register_liquidation_failure(
    request: LiquidationFailureRequest,
) -> DebtAuctionResponse:
    """Register a failed liquidation and open a bad-debt auction."""
    bound = log.bind(
        endpoint="register_liquidation_failure", vault_address=request.vault_address
    )

    debt = Decimal(str(request.debt_amount))
    collateral_value = Decimal(str(request.collateral_value))
    bad_debt = debt - collateral_value
    if bad_debt <= Decimal("0"):
        bound.info("liquidation_covered", debt=float(debt))
        raise HTTPException(
            status_code=400,
            detail="Collateral value covers debt; no bad-debt auction needed",
        )

    start_price = Decimal(str(request.start_price)) if request.start_price is not None else bad_debt
    duration = (
        float(request.duration_seconds)
        if request.duration_seconds is not None
        else DEBT_AUctION_DEFAULT_DURATION_SECONDS
    )

    auction = _open_debt_auction(
        vault_address=request.vault_address,
        debt_amount=bad_debt,
        collateral_amount=Decimal(str(request.collateral_amount)),
        start_price=start_price,
        duration_seconds=duration,
    )
    _LIQUIDATIONS_WATCHED[request.vault_address] = {
        "auction_id": auction["id"],
        "opened_at": auction["created_at"],
        "delay_seconds": DEBT_AUCTION_OPEN_DELAY_SECONDS,
    }
    bound.info(
        "debt_auction_opened",
        auction_id=auction["id"],
        bad_debt=float(bad_debt),
        delay_seconds=DEBT_AUctION_OPEN_DELAY_SECONDS,
    )
    return DebtAuctionResponse(__serialize_auction(auction))


@router.get("/debt-auctions", response_model=List[DebtAuctionResponse])
async def list_debt_auctions(
    status: Optional[str] = None,
) -> List[DebtAuctionResponse]:
    """List debt auctions, optionally filtered by status."""
    bound = log.bind(endpoint="list_debt_auctions", status=status)
    now = _utc_now()
    results: List[DebtAuctionResponse] = []
    for auction in _DEBT_AUctIONS.values():
        if auction["status"] == "open" and now >= auction["end_time"]:
            auction["status"] = "expired"
        if status is not None and auction["status"] != status:
            continue
        results.append(DebtAuctionResponse(__serialize_auction(auction)))
    bound.info("debt_auctions_listed", count=len(results))
    return results


@router.get("/debt-auctions/{auction_id}", response_model=DebtAuctionResponse)
async def get_debt_auction(auction_id: str) -> DebtAuctionResponse:
    """Get a single debt auction with its current price threshold."""
    auction = _DEBT_AUCTIONS.get(auction_id)
    if not auction:
        raise HTTPException(status_code=404, detail=f"Auction {auction_id} not found")
    if auction["status"] == "open" and _utc_now() >= auction["end_time"]:
        auction["status"] = "expired"
    return DebtAuctionResponse(__serialize_auction(auction))


@router.post("/debt-auctions/{auction_id}/bid", response_model=BidResponse)
async def place_bid(auction_id: str, request: BidRequest) -> BidResponse:
    """Place a bid against the current decaying threshold."""
    bound = log.bind(endpoint="place_bid", auction_id=auction_id)
    auction = _DEBT_AUctIONS.get(auction_id)
    if not auction:
        raise HTTPException(status_code=404, detail=f"Auction {auction_id} not found")
    if auction["status"] != "open":
        raise HTTPException(
            status_code=409, detail=f"Auction {auction_id} is not open"
        )
    if _utc_now() >= auction["end_time"]:
        auction["status"] = "expired"
        raise HTTPException(status_code=409, detail="Auction has expired")

    threshold = _current_threshold(auction)
    bid_amount = Decimal(str(request.bid_amount))
    if bid_amount < threshold:
        raise HTTPException(
            status_code=400,
            detail=f"Bid {float(bid_amount)} below current threshold {float(threshold)}",
        )

    auction["winning_bid"] = bid_amount
    auction["winner"] = request.bidder
    bound.info(
        "bid_accepted",
        bidder=request.bidder,
        bid_amount=float(bid_amount),
        threshold=float(threshold),
    )
    return BidResponse(
        success=True,
        auction_id=auction_id,
        bid_amount=float(bid_amount),
        current_threshold=float(threshold),
        message="Bid accepted as leading bid",
    )


@router.post("/debt-auctions/{auction_id}/settle", response_model=SettleAuctionResponse)
async def settle_debt_auction(auction_id: str) -> SettleAuctionResponse:
    """Settle a winning bid and burn the corresponding protocol debt."""
    bound = log.bind(endpoint="settle_debt_auction", auction_id=auction_id)
    auction = _DEBT_AUctIONS.get(auction_id)
    if not auction:
        raise HTTPException(status_code=404, detail=f"Auction {auction_id} not found")
    if auction["status"] == "settled":
        raise HTTPException(status_code=409, detail="Auction already settled")
    if auction["winning_bid"] is None:
        raise HTTPException(status_code=409, detail="Auction has no winning bid")

    debt_burned = min(auction["winning_bid"], auction["debt_amount"])
    auction["status"] = "settled"
    bound.info(
        "debt_auction_settled",
        winner=auction["winner"],
        debt_burned=float(debt_burned),
    )
    return SettleAuctionResponse(
        success=True,
        auction_id=auction_id,
        winner=auction["winner"],
        winning_bid=float(auction["winning_bid]),
        debt_burned=float(debt_burned),
        message="Auction settled and protocol debt burned",
    )
