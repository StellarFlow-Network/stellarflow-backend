from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal, ROUND_FLOOR

@dataclass(frozen=True)
class LiquidationPosition:
    position_id: str
    collateral_asset: str
    side: str
    liquidation_price: Decimal
    exposure_value: Decimal

@dataclass(frozen=True)
class HeatmapBucket:
    price_lower: Decimal
    price_upper: Decimal
    long_exposure: Decimal
    short_exposure: Decimal
    total_exposure: Decimal
    position_count: int

def build_liquidation_heatmap(positions, *, bucket_size=Decimal("10"),
                              min_price=None, max_price=None):
    if bucket_size <= 0:
        raise ValueError("bucket_size must be positive")
    grouped = defaultdict(lambda: {"long": Decimal("0"), "short": Decimal("0"), "count": 0})
    for position in positions:
        price = position.liquidation_price
        if price <= 0 or position.exposure_value < 0:
            raise ValueError("invalid liquidation price or exposure")
        if min_price is not None and price < min_price:
            continue
        if max_price is not None and price > max_price:
            continue
        lower = (price / bucket_size).to_integral_value(rounding=ROUND_FLOOR) * bucket_size
        side = "long" if position.side == "long" else "short"
        grouped[lower][side] += position.exposure_value
        grouped[lower]["count"] += 1
    result = []
    for lower in sorted(grouped):
        row = grouped[lower]
        upper = lower + bucket_size
        total = row["long"] + row["short"]
        result.append(HeatmapBucket(lower, upper, row["long"], row["short"], total, row["count"]))
    return result

def heatmap_response(buckets, *, collateral_asset=None, generated_at=None):
    rows = []
    for bucket in buckets:
        rows.append({
            "price_lower": str(bucket.price_lower),
            "price_upper": str(bucket.price_upper),
            "long_exposure": str(bucket.long_exposure),
            "short_exposure": str(bucket.short_exposure),
            "total_exposure": str(bucket.total_exposure),
            "position_count": bucket.position_count,
        })
    return {"collateral_asset": collateral_asset, "generated_at": generated_at,
            "bucket_count": len(rows), "buckets": rows}
