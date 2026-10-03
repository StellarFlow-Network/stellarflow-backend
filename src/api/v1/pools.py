from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, List, Optional

from fastapi import APIRouter, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field

from src.api.schemas import ErrorResponse, PoolStatsResponse
from src.cache.redis_cache import cache_response

router = APRRouter(prefix="/pools", tags=["Pools"])

# Mock database of pool stats for analytics engine
_MOCK_POOLS: dict[str, dict] = {
    "xlm-usdc": {
        "pool_id": "xlm-usdc",
        "asset_pair": "XLM/USDC",
        "total_liquidity_usd": 1450230.50,
        "volume_24h_usd": 382100.75,
        "fee_apy_percent": 12.45,
        "current_price": 0.1245,
        "price_change_24h_percent": 2.15,
        "total_trades_24h": 1420,
        "status": "active",
    },
    "xlm-ngn": {
        "pool_id": "xlm-ngn",
        "asset_pair": "XLM/NGN",
        "total_liquidity_usd": 890450.00,
        "volume_24h_usd": 215600.25,
        "fee_apy_percent": 18.20,
        "current_price": 185.50,
        "price_change_24h_percent": -0.85,
        "total_trades_24h": 980,
        "status": "active",
    },
    "usdc-kes": {
        "pool_id": "usdc-kes",
        "asset_pair": "USDC/KES",
        "total_liquidity_usd": 620100.00,
        "volume_24h_usd": 142300.00,
        "fee_apy_percent": 14.10,
        "current_price": 129.20,
        "price_change_24h_percent": 0.45,
        "total_trades_24h": 650,
        "status": "active",
    },
}


class TwapSliceBaseModel(BaseModel):
    slice_index: int = Field(..., description="Ordinal index of the TWAP slice")
    execute_at: datetime = Field(..., description="Scheduled execution timestamp (UTC)")
    sell_asset: str = Field(..., description="Asset being sold")
    buy_asset: str = Field(..., description="Asset being bought")
    amount_in: float = Field(..., description="Input amount for this slice")
    expected_output: float = Field(..., description="Expected output amount after fees and impact")
    price_impact_percent: float = Field(..., description="Estimated price impact for this slice")
    gas_cost_x_lm: float = Field(..., description="Estimated gas cost in XLM")
    gas_cost_usd: float = Field(..., description="Estimated gas cost in USD")


class TwapScheduleResponse(BaseModel):
    pool_id: str = Field(..., description="Pool used for the diversification swap")
    asset_pair: str = Field(..., description="Asset pair for the swap")
    sell_asset: str = Field(..., description="Asset being sold")
    buy_asset: str = Field(..., description="Asset being bought")
    total_amount_in: float = Field(..., description="Total input amount to swap")
    total_expected_output: float = Field(..., description="Total expected output across all slices")
    slice_count: int = Field(..., description="Number of TWAP slices")
    interval_seconds: int = Field(..., description="Interval between slices in seconds")
    max_price_impact_percent: float = Field(..., description="Maximum price impact across all slices")
    total_gas_cost_x_lm: float = Field(..., description="Total gas cost in XLM")
    total_gas_cost_usd: float = Field(..., description="Total gas cost in USD")
    gas_cost_breakdown: dict[str, float] = Field(..., description="Gas cost breakdown by component")
    schedule: List[TwapSliceBaseModel] = Field(..., description="Execution schedule of TWAP slices")
    updated_at: datetime = Field(..., description="Timestamp of the estimate")


def _get_pool_data(pool_id: str) -> dict:
    clean_id = pool_id.lower().strip()
    if clean_id in _MOCK_POOLS:
        return _MOCK_POOLS[clean_id]
    if "-" in clean_id:
        parts = clean_id.split("-")
        asset1, asset2 = parts[0].upper(), parts[1].upper()
        return {
            "pool_id": clean_id,
            "asset_pair": f"{asset1}/{asset2}",
            "total_liquidity_usd": 500000.00,
            "volume_24h_usd": 100000.00,
            "fee_apy_percent": 10.00,
            "current_price": 1.00,
            "price_change_24h_percent": 0.00,
            "total_trades_24h": 300,
            "status": "active",
        }
    raise HTTPException(
        status_code=404,
        detail=f"Liquidity pool '{pool_id}' not found",
    )


def _constant_product_output(
    amount_in: float,
    reserve_in: float,
    reserve_out: float,
    fee_rate: float,
) -> float:
    if amount_in <= 0 or reserve_in <= 0 or reserve_out <= 0:
        return 0.0
    amount_in_after_fee = amount_in * (1.0 - fee_rate)
    numerator = amount_in_after_fee * reserve_out
    denominator = reserve_in + amount_in_after_fee
    if denominator <= 0:
        return 0.0
    return numerator / denominator


def _price_impact_percent(
    amount_in: float,
    reserve_in: float,
    reserve_out: float,
    fee_rate: float,
) -> float:
    if amount_in <= 0 or reserve_in <= 0 or reserve_out <= 0:
        return 0.0
    spot_price = reserve_out / reserve_in
    output = _constant_product_output(amount_in, reserve_in, reserve_out, fee_rate)
    if output <= 0:
        return 0.0
    effective_price = output / amount_in
    if spot_price <= 0:
        return 0.0
    impact = (1.0 - effective_price / spot_price) * 100.0
    return max(0.0, impact)


def _estimate_gas_cost(
    slice_count: int,
    gas_price_x_lm: float,
    base_gas_per_swap: float,
    complexity_factor: float,
) -> dict:
    total_gas_x_lm = slice_count * base_gas_per_swap * complexity_factor * gas_price_x_lm
    breakdown = {
        "base_gas_per_slice_x_lm": base_gas_per_swap * gas_price_x_lm,
        "complexity_factor": complexity_factor,
        "slice_count": float(slice_count),
        "total_gas_x_lm": total_gas_x_lm,
    }
    return breakdown


def _build_twap_schedule(
    pool_data: dict,
    total_amount_in: float,
    slice_count: int,
    interval_seconds: int,
    gas_price_x_lm: float,
    base_gas_per_swap: float,
    complexity_factor: float,
    xlm_price_usd: float,
    max_impact_percent: float,
    now: datetime,
) -> TwapScheduleResponse:
    pool_id = pool_data["pool_id"]
    asset_pair = pool_data["asset_pair"]
    sell_asset, buy_asset = asset_pair.split("/")
    current_price = float(pool_data["current_price"])
    liquidity_usd = float(pool_data["total_liquidity_usd"])
    fee_rate = float(pool_data["fee_apy_percent"]) / 100.0
    fee_rate = min(max(fee_rate, 0.0001), 0.1)

    reserve_out = liquidity_usd / 2.0
    if current_price <= 0:
        reserve_in = reserve_out
    else:
        reserve_in = reserve_out / current_price

    slice_amount = total_amount_in / float(slice_count)
    schedule: List[TwapSliceBaseModel] = []
    total_output = 0.0
    max_impact = 0.0
    gas_cost_x_lm = base_gas_per_swap * complexity_factor * gas_price_x_lm

    for i in range(slice_count):
        output = _constant_product_output(slice_amount, reserve_in, reserve_out, fee_rate)
        impact = _price_impact_percent(slice_amount, reserve_in, reserve_out, fee_rate)
        if impact > max_impact:
            max_impact = impact
        total_output += output
        execute_at = now + timedelta(seconds=i * interval_seconds)
        schedule.append(
            TwapSliceBaseModel(
                slice_index=i,
                execute_at=execute_at,
                sell_asset=sell_asset,
                buy_asset=buy_asset,
                amount_in=round(slice_amount, 8),
                expected_output=round(output, 8),
                price_impact_percent=round(impact, 6),
                gas_cost_x_lm=round(gas_cost_x_lm, 8),
                gas_cost_usd=round(gas_cost_x_lm * xlm_price_usd, 8),
            )
        )
        reserve_in += slice_amount
        reserve_out -= output
        if reserve_out <= 0:
            reserve_out = 1.0

    gas_breakdown = _estimate_gas_cost(
        slice_count=slice_count,
        gas_price_x_lm=gas_price_x_lm,
        base_gas_per_swap=base_gas_per_swap,
        complexity_factor=complexity_factor,
    )
    total_gas_x_lm = gas_breakdown["total_gas_x_lm"]
    gas_breakdown["total_gas_usd"] = total_gas_x_lm * xlm_price_usd
    gas_breakdown["average_gas_per_slice_x_lm"] = (
        total_gas_x_lm / slice_count if slice_count > 0 else 0.0
    )

    return TwapScheduleResponse(
        pool_id=pool_id,
        asset_pair=asset_pair,
        sell_asset=sell_asset,
        buy_asset=buy_asset,
        total_amount_in=round(total_amount_in, 8),
        total_expected_output=round(total_output, 8),
        slice_count=slice_count,
        interval_seconds=interval_seconds,
        max_price_impact_percent=round(max_impact, 6),
        total_gas_cost_x_lm=round(total_gas_x_lm, 8),
        total_gas_cost_usd=round(total_gas_x_lm * xlm_price_usd, 8),
        gas_cost_breakdown=gas_breakdown,
        schedule=schedule,
        updated_at=now,
    )


@router.get(
    "/{pool_id}/stats",
    response_model=PoolStatsResponse,
    summary="Get Pool Statistics",
    description=(
        "Fetch real-time analytics statistics for a liquidity pool by its ID. "
        "Responses are cached for 15 seconds via Redis."
    ),
    responses={
        200: {"description": "Pool statistics returned successfully", "model": PoolStatsResponse},
        404: {"description": "Liquidity pool not found", "model": ErrorResponse},
    },
)
@cache_response(ttl=15)
async def get_pool_stats(
    request: Request,
    pool_id: str = Path(
        ...,
        description="Unique pool identifier (e.g., 'wlm-usdc', 'wlm-ngn')",
        example="xlm-usdc",
    ),
) -> PoolStatsResponse:
    """Retrieve pool statistics by pool ID."""
    data = _get_pool_data(pool_id)
    now_iso = datetime.now(timezone.utc).isoformat()
    return PoolStatsResponse(**{**data, "updated_at": now_iso})


@router.get(
    "/{pool_id}/dividend-swap-simulation",
    response_model=TwapScheduleResponse,
    summary="Simulate Treasury Diversification TWAP Swap",
    description=(
        "Simulate the market impact of a large treasury diversification swap by "
        "splitting it into TIME-WEIGHTED AVERAGE PRICE (TWAP) orders. Returns the "
        "execution schedule, per-slice price impact, and a gas cost breakdown."
    ),
    responses={
        200: {"description": "TWAP schedule generated", "model": TwapScheduleResponse},
        400: {"description": "Invalid simulation parameters", "model": ErrorResponse},
        404: {"description": "Liquidity pool not found", "model": ErrorResponse},
    },
)
async def simulate_diversification_swap(
    request: Request,
    pool_id: str = Path(
        ...,
        description="Unique pool identifier (e.g., 'wlm-usdc', 'wlm-ngn')",
        example="xlm-usdc",
    ),
    amount_in: float = Query(
        ...,
        gt=0,
        description="Total input amount to diversify",
        example=10000.0,
    ),
    slice_count: int = Query(
        4,
        ge=1,
        le=144,
        description="Number of TWAP slices to split the order into",
        example=4,
    ),
    interval_seconds: int = Query(
        300,
        ge=1,
        le=86400,
        description="Interval between TWAP slices in seconds",
        example=300,
    ),
    gas_price_x_lm: float = Query(
        0.00001,
        gt=0,
        description="Gas price in XLM per gas unit",
        example=0.00001,
    ),
    base_gas_per_swap: float = Query(
        1000.0,
        gt=0,
        description="Base gas units consumed per swap operation",
        example=1000.0,
    ),
    complexity_factor: float = Query(
        1.0,
        gt=0,
        description="Multiplier for route complexity gas overhead",
        example=1.0,
    ),
    xlm_price_usd: float = Query(
        0.1245,
        gt=0,
        description="XLM price in USD for gas cost conversion",
        example=0.1245,
    ),
    max_impact_percent: float = Query(
        0.5,
        gt=0,
        description="Maximum acceptable price impact per slice in percent",
        example=0.5,
    ),
) -> TwapScheduleResponse:
    """Simulate a treasury diversification swap using a TWAP execution schedule."""
    pool_data = _get_pool_data(pool_id)
    now = datetime.now(timezone.utc)
    schedule_response = _build_twap_schedule(
        pool_data=pool_data,
        total_amount_in=amount_in,
        slice_count=slice_count,
        interval_seconds=interval_seconds,
        gas_price_x_lm=gas_price_x_lm,
        base_gas_per_swap=base_gas_per_swap,
        complexity_factor=complexity_factor,
        xlm_price_usd=xlm_price_usd,
        max_impact_percent=max_impact_percent,
        now=now,
    )
    return schedule_response


@__router.get(
    "/{}/dividending-swap-simulation",
    response_model=TwapScheduleResponse,
    summary="Simulate Treasury Diversification TWAP Swap (alias)",
    include_in_schema=False,
    description="Alias route for the TWAP diversification swap simulator.",
)
async def simulate_diversification_swap_alias(
    request: Request,
    pool_id: str = Path(..., description="Unique pool identifier"),
    amount_in: float = Query(..., gt=0),
    slice_count: int = Query(4, ge=1, le=144),
    interval_seconds: int = Query(300, ge=1, le=86400),
    gas_price_x_lm: float = Query(0.00001, gt=0),
    base_gas_per_swap: float = Query(1000.0, gt=0),
    complexity_factor: float = Query(1.0, gt=0),
    xlm_price_usd: float = Query(0.1245, gt=0),
    max_impact_percent: float = Query(0.5, gt=0),
) -> TwapScheduleResponse:
    return await simulate_diversification_swap(
        request=request,
        pool_id=pool_id,
        amount_in=amount_in,
        slice_count=slice_count,
        interval_seconds=interval_seconds,
        gas_price_x_lm=gas_price_x_lm,
        base_gas_per_swap=base_gas_per_swap,
        complexity_factor=complexity_factor,
        xlm_price_usd=xlm_price_usd,
        max_impact_percent=max_impact_percent,
    )


__all__ = ["router"]
