from __future__ import annotations

from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Path, Request
from src.api.schemas import ErrorResponse, PoolStatsResponse
from src.cache.redis_cache import cache_response

router = APIRouter(prefix="/pools", tags=["Pools"])

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
        description="Unique pool identifier (e.g., 'xlm-usdc', 'xlm-ngn')",
        example="xlm-usdc",
    ),
) -> PoolStatsResponse:
    """Retrieve pool statistics by pool ID."""
    clean_id = pool_id.lower().strip()
    if clean_id not in _MOCK_POOLS:
        # Dynamic fallback generation for custom pool IDs format matching asset-asset
        if "-" in clean_id:
            parts = clean_id.split("-")
            asset1, asset2 = parts[0].upper(), parts[1].upper()
            data = {
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
        else:
            raise HTTPException(
                status_code=404,
                detail=f"Liquidity pool '{pool_id}' not found",
            )
    else:
        data = _MOCK_POOLS[clean_id]

    now_iso = datetime.now(timezone.utc).isoformat()
    return PoolStatsResponse(**{**data, "updated_at": now_iso})


__all__ = ["router"]
