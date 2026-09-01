"""FastAPI router for flash-loan revenue accounting and yield analytics endpoints."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import asyncpg
import structlog
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.celery_app import celery_app
from app.tasks import ingest_flash_loan_revenue, compute_yield_snapshots

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/analytics", tags=["Analytics"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class FlashLoanRevenueResponse(BaseModel):
    id: str
    ledger_sequence: int
    tx_hash: str
    event_index: int
    amount: Optional[float] = None
    treasury_account: Optional[str] = None
    block_time: Optional[datetime] = None
    created_at: Optional[datetime] = None


class ProtocolYieldSnapshotResponse(BaseModel):
    id: str
    granularity: str
    window_start: datetime
    window_end: datetime
    total_flash_loan_revenue: Optional[float] = None
    total_treasury_balance: Optional[float] = None
    yield_apy: Optional[float] = None
    fee_volume: Optional[float] = None
    event_count: Optional[int] = None
    created_at: Optional[datetime] = None


class CumulativeMetricsResponse(BaseModel):
    total_revenue: float
    total_events: int
    treasury_accounts: List[str]
    first_event_at: Optional[datetime] = None
    last_event_at: Optional[datetime] = None


class TriggerIngestResponse(BaseModel):
    success: bool
    task_id: str
    queued: bool = True


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/flash-loan-revenue", response_model=List[FlashLoanRevenueResponse])
async def get_flash_loan_revenue(
    treasury_account: Optional[str] = None,
    limit: int = Field(default=100, ge=1, le=1000),
    offset: int = Field(default=0, ge=0),
) -> List[FlashLoanRevenueResponse]:
    """Return recent flash-loan revenue events, optionally filtered by treasury account."""
    database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    if not database_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not configured")

    bound = log.bind(endpoint="get_flash_loan_revenue", treasury_account=treasury_account, limit=limit, offset=offset)
    pool = await asyncpg.create_pool(database_url)
    try:
        async with pool.acquire() as connection:
            if treasury_account:
                rows = await connection.fetch(
                    """
                    SELECT id, ledger_sequence, tx_hash, event_index,
                           amount, treasury_account, block_time, created_at
                    FROM flash_loan_revenue
                    WHERE treasury_account = $1
                    ORDER BY created_at DESC
                    LIMIT $2 OFFSET $3
                    """,
                    treasury_account,
                    limit,
                    offset,
                )
            else:
                rows = await connection.fetch(
                    """
                    SELECT id, ledger_sequence, tx_hash, event_index,
                           amount, treasury_account, block_time, created_at
                    FROM flash_loan_revenue
                    ORDER BY created_at DESC
                    LIMIT $1 OFFSET $2
                    """,
                    limit,
                    offset,
                )
            bound.debug("flash_loan_revenue.queried", row_count=len(rows))
            return [
                FlashLoanRevenueResponse(
                    id=row["id"],
                    ledger_sequence=row["ledger_sequence"],
                    tx_hash=row["tx_hash"],
                    event_index=row["event_index"],
                    amount=float(row["amount"]) if row["amount"] is not None else None,
                    treasury_account=row["treasury_account"],
                    block_time=row["block_time"],
                    created_at=row["created_at"],
                )
                for row in rows
            ]
    except Exception as exc:
        bound.exception("flash_loan_revenue.query_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await pool.close()


@router.get("/yield", response_model=List[ProtocolYieldSnapshotResponse])
async def get_yield_snapshots(
    granularity: str = "DAILY",
    limit: int = Field(default=100, ge=1, le=1000),
    offset: int = Field(default=0, ge=0),
) -> List[ProtocolYieldSnapshotResponse]:
    """Return protocol yield analytics snapshots."""
    if granularity not in {"HOURLY", "DAILY"}:
        raise HTTPException(status_code=400, detail="granularity must be HOURLY or DAILY")

    database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    if not database_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not configured")

    bound = log.bind(endpoint="get_yield_snapshots", granularity=granularity, limit=limit, offset=offset)
    pool = await asyncpg.create_pool(database_url)
    try:
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT id, granularity, window_start, window_end,
                       total_flash_loan_revenue, total_treasury_balance,
                       yield_apy, fee_volume, event_count, created_at
                FROM protocol_yield_snapshot
                WHERE granularity = $1
                ORDER BY window_start DESC
                LIMIT $2 OFFSET $3
                """,
                granularity,
                limit,
                offset,
            )
            bound.debug("yield_snapshots.queried", row_count=len(rows))
            return [
                ProtocolYieldSnapshotResponse(
                    id=row["id"],
                    granularity=row["granularity"],
                    window_start=row["window_start"],
                    window_end=row["window_end"],
                    total_flash_loan_revenue=(
                        float(row["total_flash_loan_revenue"])
                        if row["total_flash_loan_revenue"] is not None
                        else None
                    ),
                    total_treasury_balance=(
                        float(row["total_treasury_balance"])
                        if row["total_treasury_balance"] is not None
                        else None
                    ),
                    yield_apy=(
                        float(row["yield_apy"])
                        if row["yield_apy"] is not None
                        else None
                    ),
                    fee_volume=(
                        float(row["fee_volume"])
                        if row["fee_volume"] is not None
                        else None
                    ),
                    event_count=(
                        int(row["event_count"])
                        if row["event_count"] is not None
                        else None
                    ),
                    created_at=row["created_at"],
                )
                for row in rows
            ]
    except Exception as exc:
        bound.exception("yield_snapshots.query_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await pool.close()


@router.get("/flash-loan-revenue/cumulative", response_model=CumulativeMetricsResponse)
async def get_cumulative_flash_loan_revenue() -> CumulativeMetricsResponse:
    """Return cumulative protocol flash-loan revenue metrics."""
    database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    if not database_url:
        raise HTTPException(status_code=500, detail="DATABASE_URL is not configured")

    bound = log.bind(endpoint="get_cumulative_flash_loan_revenue")
    pool = await asyncpg.create_pool(database_url)
    try:
        async with pool.acquire() as connection:
            row = await connection.fetchrow(
                """
                SELECT
                    COALESCE(SUM(amount), 0) AS total_revenue,
                    COUNT(*) AS total_events,
                    ARRAY_AGG(DISTINCT treasury_account) AS treasury_accounts,
                    MIN(created_at) AS first_event_at,
                    MAX(created_at) AS last_event_at
                FROM flash_loan_revenue
                """
            )
            bound.debug("cumulative_revenue.queried")
            return CumulativeMetricsResponse(
                total_revenue=float(row["total_revenue"] or 0),
                total_events=int(row["total_events"] or 0),
                treasury_accounts=[a for a in (row["treasury_accounts"] or []) if a is not None],
                first_event_at=row["first_event_at"],
                last_event_at=row["last_event_at"],
            )
    except Exception as exc:
        bound.exception("cumulative_revenue.query_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await pool.close()


@router.post("/ingest/flash-loan-revenue", response_model=TriggerIngestResponse)
async def trigger_ingest_flash_loan_revenue(
    lookback_minutes: int = 60,
) -> TriggerIngestResponse:
    """Manually trigger a flash-loan revenue ingestion task."""
    bound = log.bind(endpoint="trigger_ingest_flash_loan_revenue", lookback_minutes=lookback_minutes)
    try:
        result = ingest_flash_loan_revenue.delay(lookback_minutes=lookback_minutes)
        bound.info("ingest_flash_loan_revenue.enqueued", task_id=result.id)
        return TriggerIngestResponse(success=True, task_id=result.id)
    except Exception as exc:
        bound.exception("ingest_flash_loan_revenue.enqueue_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/compute/yield-snapshots", response_model=TriggerIngestResponse)
async def trigger_compute_yield_snapshots(
    granularity: str = "DAILY",
) -> TriggerIngestResponse:
    """Manually trigger a yield snapshot computation task."""
    if granularity not in {"HOURLY", "DAILY"}:
        raise HTTPException(status_code=400, detail="granularity must be HOURLY or DAILY")
    bound = log.bind(endpoint="trigger_compute_yield_snapshots", granularity=granularity)
    try:
        result = compute_yield_snapshots.delay(granularity=granularity)
        bound.info("compute_yield_snapshots.enqueued", task_id=result.id)
        return TriggerIngestResponse(success=True, task_id=result.id)
    except Exception as exc:
        bound.exception("compute_yield_snapshots.enqueue_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
