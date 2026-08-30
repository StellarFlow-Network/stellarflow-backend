from __future__ import annotations

from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class PoolStatsResponse(BaseModel):
    """OpenAPI schema definition for pool analytics statistics."""

    pool_id: str = Field(
        ...,
        description="Unique identifier for the liquidity pool",
        example="xlm-usdc",
    )
    asset_pair: str = Field(
        ...,
        description="Trading asset pair symbol",
        example="XLM/USDC",
    )
    total_liquidity_usd: float = Field(
        ...,
        description="Total value locked (TVL) in USD",
        example=1450230.50,
    )
    volume_24h_usd: float = Field(
        ...,
        description="24-hour trading volume in USD",
        example=382100.75,
    )
    fee_apy_percent: float = Field(
        ...,
        description="Estimated annualized fee APY percentage",
        example=12.45,
    )
    current_price: float = Field(
        ...,
        description="Current exchange rate price",
        example=0.1245,
    )
    price_change_24h_percent: float = Field(
        ...,
        description="24-hour price change percentage",
        example=2.15,
    )
    total_trades_24h: int = Field(
        ...,
        description="Number of trades executed in the last 24 hours",
        example=1420,
    )
    status: str = Field(
        ...,
        description="Operational status of the pool",
        example="active",
    )
    updated_at: str = Field(
        ...,
        description="ISO 8601 UTC timestamp of stats calculation",
        example="2026-08-30T21:00:00Z",
    )


class VolumeBySymbol(BaseModel):
    """Volume breakdown item for a specific trading symbol."""

    symbol: str = Field(
        ...,
        description="Asset symbol or pair name",
        example="XLM/NGN",
    )
    volume_usd: float = Field(
        ...,
        description="24-hour volume in USD",
        example=125000.0,
    )
    percentage_of_total: float = Field(
        ...,
        description="Share of total network volume percentage",
        example=32.7,
    )


class VolumeAnalyticsResponse(BaseModel):
    """OpenAPI schema definition for volume analytics data."""

    timeframe: str = Field(
        ...,
        description="Analytics window timeframe",
        example="24h",
    )
    total_volume_usd: float = Field(
        ...,
        description="Aggregated trading volume across all pairs in USD",
        example=382100.75,
    )
    volume_by_symbol: List[VolumeBySymbol] = Field(
        ...,
        description="Volume breakdown grouped by symbol",
    )
    historical_points: List[Dict[str, Any]] = Field(
        ...,
        description="Time-series data points for volume evolution",
    )
    volume_change_24h_percent: float = Field(
        ...,
        description="Percentage change in volume compared to previous window",
        example=5.8,
    )
    updated_at: str = Field(
        ...,
        description="ISO 8601 UTC timestamp",
        example="2026-08-30T21:00:00Z",
    )


class ServiceHealth(BaseModel):
    """Health breakdown for individual sub-services."""

    name: str = Field(
        ...,
        description="Name of the subsystem or service",
        example="redis_cache",
    )
    status: str = Field(
        ...,
        description="Status string: healthy, degraded, or offline",
        example="healthy",
    )
    latency_ms: float = Field(
        ...,
        description="Response latency in milliseconds",
        example=1.2,
    )


class HealthResponse(BaseModel):
    """OpenAPI schema definition for system health status."""

    status: str = Field(
        ...,
        description="Overall system health status ('ok' or 'degraded')",
        example="ok",
    )
    timestamp: str = Field(
        ...,
        description="ISO 8601 UTC timestamp of health check",
        example="2026-08-30T21:00:00Z",
    )
    uptime_seconds: float = Field(
        ...,
        description="Server uptime in seconds",
        example=86400.0,
    )
    redis_connected: bool = Field(
        ...,
        description="Redis cache connectivity status",
        example=True,
    )
    services: List[ServiceHealth] = Field(
        ...,
        description="Subsystem health breakdown",
    )


class ErrorResponse(BaseModel):
    """OpenAPI schema definition for standard API error responses."""

    error: str = Field(
        ...,
        description="Error message description",
        example="Pool 'invalid-pool' not found",
    )
    status_code: int = Field(
        ...,
        description="HTTP status code",
        example=404,
    )
    timestamp: str = Field(
        ...,
        description="ISO 8601 UTC timestamp",
        example="2026-08-30T21:00:00Z",
    )


__all__ = [
    "PoolStatsResponse",
    "VolumeBySymbol",
    "VolumeAnalyticsResponse",
    "ServiceHealth",
    "HealthResponse",
    "ErrorResponse",
]
