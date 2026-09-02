from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, Query, Request
from src.api.schemas import VolumeAnalyticsResponse, VolumeBySymbol
from src.cache.redis_cache import cache_response

router = APIRouter(prefix="/analytics", tags=["Analytics"])


@router.get(
    "/volume",
    response_model=VolumeAnalyticsResponse,
    summary="Get Volume Analytics",
    description=(
        "Fetch aggregated market trading volume analytics across pairs and time series points. "
        "Responses are cached for 15 seconds via Redis."
    ),
    responses={
        200: {
            "description": "Volume analytics retrieved successfully",
            "model": VolumeAnalyticsResponse,
        }
    },
)
@cache_response(ttl=15)
async def get_volume_analytics(
    request: Request,
    timeframe: str = Query(
        "24h",
        description="Analytics aggregation timeframe: '1h', '24h', '7d', or '30d'",
        example="24h",
    ),
    symbol: Optional[str] = Query(
        None,
        description="Optional filter by trading symbol (e.g. 'XLM/USD', 'XLM/NGN')",
        example="XLM/USD",
    ),
    limit: int = Query(
        50,
        ge=1,
        le=1000,
        description="Maximum number of historical time-series data points",
        example=24,
    ),
) -> VolumeAnalyticsResponse:
    """Retrieve volume analytics data."""
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    symbols_data = [
        VolumeBySymbol(symbol="XLM/USDC", volume_usd=382100.75, percentage_of_total=51.6),
        VolumeBySymbol(symbol="XLM/NGN", volume_usd=215600.25, percentage_of_total=29.1),
        VolumeBySymbol(symbol="USDC/KES", volume_usd=142300.00, percentage_of_total=19.3),
    ]

    if symbol:
        clean_sym = symbol.upper().strip()
        filtered = [s for s in symbols_data if s.symbol.upper() == clean_sym]
        if filtered:
            symbols_data = filtered
            total_vol = filtered[0].volume_usd
        else:
            symbols_data = [
                VolumeBySymbol(symbol=clean_sym, volume_usd=50000.0, percentage_of_total=100.0)
            ]
            total_vol = 50000.0
    else:
        total_vol = sum(s.volume_usd for s in symbols_data)

    # Generate synthetic time-series history points bounded by limit
    num_points = min(limit, 24 if timeframe == "24h" else 10)
    historical_points = [
        {
            "timestamp": now_iso,
            "volume_usd": round(total_vol / max(num_points, 1), 2),
            "trades_count": 50 + i * 5,
        }
        for i in range(num_points)
    ]

    return VolumeAnalyticsResponse(
        timeframe=timeframe,
        total_volume_usd=round(total_vol, 2),
        volume_by_symbol=symbols_data,
        historical_points=historical_points,
        volume_change_24h_percent=5.8,
        updated_at=now_iso,
    )


__all__ = ["router"]
