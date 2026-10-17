"""Pool price-impact simulation and seven-day APY source calculations."""

from __future__ import annotations

import asyncio
import math
import os
from datetime import datetime, timedelta, timezone
from typing import Any

TRADE_SIZE_TIERS_USD = (100.0, 1_000.0, 10_000.0, 100_000.0, 1_000_000.0)
DEFAULT_FEE_TIER_BPS = 30
_database_pool: Any = None
_database_pool_lock = asyncio.Lock()


def build_price_impact_heatmap(pool: dict[str, Any]) -> dict[str, Any]:
    """Simulate quote-asset input over a finite, symmetric active price range.

    Pool statistics currently provide TVL and spot price, not on-chain ticks.
    The range and active liquidity are therefore explicitly reported as an
    estimate rather than presented as a live quote.
    """
    liquidity_usd = float(pool["total_liquidity_usd"])
    spot_price = float(pool["current_price"])
    if not math.isfinite(liquidity_usd) or liquidity_usd <= 0:
        raise ValueError("Pool liquidity must be positive")
    if not math.isfinite(spot_price) or spot_price <= 0:
        raise ValueError("Pool spot price must be positive")

    asset0, asset1 = pool["asset_pair"].split("/", maxsplit=1)
    sqrt_price = math.sqrt(spot_price)
    lower_price = float(pool.get("range_lower_price", spot_price * 0.9))
    upper_price = float(pool.get("range_upper_price", spot_price * 1.1))
    quote_asset_price_usd = float(
        pool.get("quote_asset_price_usd", 1.0 if pool["asset_pair"].split("/")[1] in {"USD", "USDC", "USDT"} else 0)
    )
    fee_tier_bps = int(pool.get("fee_tier_bps", DEFAULT_FEE_TIER_BPS))
    if not (0 < lower_price < spot_price < upper_price):
        raise ValueError("Pool price range must contain the current spot price")
    if not math.isfinite(quote_asset_price_usd) or quote_asset_price_usd <= 0:
        raise ValueError("USD conversion for the quote asset is required")
    if not 0 <= fee_tier_bps < 10_000:
        raise ValueError("Pool fee tier must be between 0 and 9999 basis points")
    sqrt_lower = math.sqrt(lower_price)
    sqrt_upper = math.sqrt(upper_price)
    # Value of both concentrated-liquidity assets at spot, per unit L.
    value_per_liquidity = (
        2 * sqrt_price - spot_price / sqrt_upper - sqrt_lower
    )
    if not math.isfinite(value_per_liquidity) or value_per_liquidity <= 0:
        raise ValueError("Pool price range produces invalid active liquidity")
    active_liquidity = liquidity_usd / (quote_asset_price_usd * value_per_liquidity)
    if not math.isfinite(active_liquidity) or active_liquidity <= 0:
        raise ValueError("Pool active liquidity is invalid")
    fee_rate = fee_tier_bps / 10_000
    tiers = []

    for trade_size in TRADE_SIZE_TIERS_USD:
        amount_in_quote = trade_size / quote_asset_price_usd
        amount_after_fee = amount_in_quote * (1 - fee_rate)
        sqrt_after = min(
            sqrt_price + amount_after_fee / active_liquidity,
            sqrt_upper,
        )
        output = active_liquidity * (1 / sqrt_price - 1 / sqrt_after)
        impact = max(
            0.0,
            (1 - output * spot_price * quote_asset_price_usd / trade_size) * 100,
        )
        tiers.append(
            {
                "trade_size_usd": trade_size,
                "estimated_output": round(output, 10),
                "price_impact_percent": round(impact, 6),
                "liquidity_exhausted": amount_after_fee
                > active_liquidity * (sqrt_upper - sqrt_price),
            }
        )

    return {
        "pool_id": pool["pool_id"],
        "asset_pair": pool["asset_pair"],
        "quote_asset": asset1,
        "base_asset": asset0,
        "spot_price": spot_price,
        "range_lower_price": lower_price,
        "range_upper_price": upper_price,
        "fee_tier_bps": fee_tier_bps,
        "liquidity_model": "estimated_single_range",
        "tiers": tiers,
    }


async def _get_database_pool() -> Any:
    global _database_pool
    if _database_pool is not None:
        return _database_pool
    database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    if not database_url:
        raise RuntimeError("DATABASE_URL is required for pool APY analytics")
    async with _database_pool_lock:
        if _database_pool is None:
            try:
                import asyncpg

                _database_pool = await asyncpg.create_pool(
                    database_url,
                    min_size=1,
                    max_size=4,
                    command_timeout=3,
                )
            except Exception as exc:
                raise RuntimeError("Could not connect to pool analytics database") from exc
    return _database_pool


async def close_pool_metrics_pool() -> None:
    """Close the shared database pool during API shutdown."""
    global _database_pool
    if _database_pool is not None:
        await _database_pool.close()
        _database_pool = None


async def get_pool_apy_breakdown(pool_id: str) -> dict[str, Any]:
    """Compute trailing fee APY and active reward-emission APY independently."""
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=7)
    database_pool = await _get_database_pool()
    try:
        async with database_pool.acquire() as connection:
            fee_rows = await connection.fetch(
                '''SELECT timestamp, "fees24h", tvl
                   FROM "PoolVolumeAnalytics"
                   WHERE "poolId" = $1 AND timestamp >= $2 AND timestamp <= $3
                   ORDER BY timestamp ASC''',
                pool_id,
                start,
                end,
            )
            reward_rows = await connection.fetch(
                '''SELECT "tokenCode", "amountPerSecond", "tokenPriceUsd", "startsAt", "endsAt"
                   FROM "PoolRewardEmission"
                   WHERE "poolId" = $1 AND "startsAt" <= $2
                     AND ("endsAt" IS NULL OR "endsAt" > $2)''',
                pool_id,
                end,
            )
    except Exception as exc:
        raise RuntimeError("Pool APY source data is unavailable") from exc

    latest_by_day: dict[Any, Any] = {}
    for row in fee_rows:
        latest_by_day[row["timestamp"].date()] = row
    if len(latest_by_day) < 7:
        raise RuntimeError("At least seven daily pool analytics samples are required")

    daily_rows = list(latest_by_day.values())
    fees_7d = sum(float(row["fees24h"]) for row in daily_rows)
    average_liquidity = sum(float(row["tvl"]) for row in daily_rows) / len(daily_rows)
    if average_liquidity <= 0:
        raise RuntimeError("Pool liquidity history must be positive")

    fee_apy = fees_7d / average_liquidity * (365 / 7) * 100
    emissions = []
    reward_apy = 0.0
    for row in reward_rows:
        annual_value = (
            float(row["amountPerSecond"])
            * float(row["tokenPriceUsd"])
            * 365
            * 24
            * 60
            * 60
        )
        emission_apy = annual_value / average_liquidity * 100
        reward_apy += emission_apy
        emissions.append(
            {
                "token_code": row["tokenCode"],
                "amount_per_second": float(row["amountPerSecond"]),
                "token_price_usd": float(row["tokenPriceUsd"]),
                "apy_percent": emission_apy,
                "starts_at": row["startsAt"],
                "ends_at": row["endsAt"],
            }
        )

    return {
        "pool_id": pool_id,
        "trading_fee_apy_percent": round(fee_apy, 6),
        "reward_emission_apy_percent": round(reward_apy, 6),
        "total_apy_percent": round(fee_apy + reward_apy, 6),
        "fees_7d_usd": round(fees_7d, 8),
        "average_liquidity_usd": round(average_liquidity, 8),
        "reward_emissions": emissions,
        "window_start": start,
        "window_end": end,
        "updated_at": end,
    }