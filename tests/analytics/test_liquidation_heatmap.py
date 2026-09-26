from decimal import Decimal
import pytest
from app.analytics.liquidation_heatmap import LiquidationPosition, build_liquidation_heatmap, heatmap_response

def p(pid, side, price, exposure):
    return LiquidationPosition(pid, "XLM", side, Decimal(price), Decimal(exposure))

def test_groups_positions():
    buckets = build_liquidation_heatmap([
        p("1", "long", "101", "100"),
        p("2", "long", "109", "50"),
        p("3", "short", "111", "75"),
    ], bucket_size=Decimal("10"))
    assert len(buckets) == 2
    assert buckets[0].long_exposure == Decimal("150")
    assert buckets[1].short_exposure == Decimal("75")

def test_filters():
    buckets = build_liquidation_heatmap(
        [p("1", "long", "101", "100"), p("2", "long", "201", "200")],
        bucket_size=Decimal("10"), min_price=Decimal("150")
    )
    assert buckets[0].total_exposure == Decimal("200")

def test_invalid_bucket_size():
    with pytest.raises(ValueError):
        build_liquidation_heatmap([], bucket_size=Decimal("0"))

def test_response():
    buckets = build_liquidation_heatmap([p("1", "long", "101", "100")])
    response = heatmap_response(buckets, collateral_asset="XLM")
    assert response["bucket_count"] == 1
    assert response["buckets"][0]["total_exposure"] == "100"
