from decimal import Decimal
from typing import Annotated
from fastapi import APIRouter, Query
from app.analytics.liquidation_heatmap import build_liquidation_heatmap, heatmap_response

router = APIRouter(prefix="/vaults", tags=["vaults"])

@router.get("/liquidation-heatmap")
async def get_liquidation_heatmap(
    collateral_asset: str | None = None,
    bucket_size: Annotated[Decimal, Query(gt=0)] = Decimal("10"),
    min_price: Decimal | None = Query(default=None, gt=0),
    max_price: Decimal | None = Query(default=None, gt=0),
):
    positions = await _load_active_positions(collateral_asset, min_price, max_price)
    buckets = build_liquidation_heatmap(
        positions, bucket_size=bucket_size, min_price=min_price, max_price=max_price
    )
    return heatmap_response(buckets, collateral_asset=collateral_asset)

async def _load_active_positions(collateral_asset, min_price, max_price):
    raise NotImplementedError("Connect to the active vault-position store and risk engine")
