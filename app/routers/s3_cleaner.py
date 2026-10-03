"""FastAPI router for S3 temporary-export cleanup operations (Issue #979).

Exposes two endpoints:
- ``POST /api/v1/storage/cleanup/trigger``   — enqueue a cleanup run manually
- ``GET  /api/v1/storage/cleanup/status``    — inspect recent cleanup run logs
"""

from __future__ import annotations

import os
from datetime import datetime
from typing import Any, Dict, List, Optional

import asyncpg
import structlog
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.tasks import purge_s3_temp_exports

log = structlog.get_logger(__name__)

router = APIRouter(prefix="/storage", tags=["Storage"])


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class CleanupTriggerResponse(BaseModel):
    success: bool
    task_id: str
    queued: bool = True
    dry_run: bool = False


class CleanupRunLogResponse(BaseModel):
    id: str
    bucket: str
    prefix: Optional[str] = None
    ttl_hours: int
    dry_run: bool
    objects_scanned: int
    objects_deleted: int
    bytes_reclaimed: int
    error_count: int
    duration_ms: Optional[float] = None
    started_at: datetime
    completed_at: datetime
    created_at: datetime


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/cleanup/trigger", response_model=CleanupTriggerResponse)
async def trigger_s3_cleanup(
    dry_run: bool = Query(
        default=False,
        description=(
            "When true the worker scans and reports stale objects without "
            "deleting them.  Useful for pre-production validation."
        ),
    ),
) -> CleanupTriggerResponse:
    """Manually enqueue an S3 temporary-export cleanup task.

    The worker will scan ``stellarflow-temp-exports`` (or the bucket configured
    via ``S3_TEMP_EXPORTS_BUCKET``) and delete every CSV / PDF export object
    whose ``LastModified`` timestamp is older than ``S3_TEMP_EXPORTS_TTL_HOURS``
    hours (default: 24).
    """
    bound = log.bind(endpoint="trigger_s3_cleanup", dry_run=dry_run)
    try:
        result = purge_s3_temp_exports.delay(dry_run=dry_run)
        bound.info("s3_cleanup.enqueued", task_id=result.id)
        return CleanupTriggerResponse(
            success=True,
            task_id=result.id,
            queued=True,
            dry_run=dry_run,
        )
    except Exception as exc:
        bound.exception("s3_cleanup.enqueue_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/cleanup/status", response_model=List[CleanupRunLogResponse])
async def get_cleanup_run_logs(
    limit: int = Query(default=20, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> List[CleanupRunLogResponse]:
    """Return recent S3 cleanup run log entries ordered by most recent first.

    Each entry reflects a completed ``purge_s3_temp_exports`` task run and
    records how many objects were scanned, deleted, and how many bytes were
    reclaimed.
    """
    database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    if not database_url:
        raise HTTPException(
            status_code=500, detail="DATABASE_URL is not configured"
        )

    bound = log.bind(endpoint="get_cleanup_run_logs", limit=limit, offset=offset)
    pool = await asyncpg.create_pool(database_url)
    try:
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT id, bucket, prefix, ttl_hours, dry_run,
                       objects_scanned, objects_deleted, bytes_reclaimed,
                       error_count, duration_ms, started_at, completed_at,
                       created_at
                FROM s3_cleanup_run_log
                ORDER BY started_at DESC
                LIMIT $1 OFFSET $2
                """,
                limit,
                offset,
            )
        bound.debug("cleanup_run_logs.queried", row_count=len(rows))
        return [
            CleanupRunLogResponse(
                id=row["id"],
                bucket=row["bucket"],
                prefix=row["prefix"],
                ttl_hours=row["ttl_hours"],
                dry_run=row["dry_run"],
                objects_scanned=row["objects_scanned"],
                objects_deleted=row["objects_deleted"],
                bytes_reclaimed=row["bytes_reclaimed"],
                error_count=row["error_count"],
                duration_ms=(
                    float(row["duration_ms"])
                    if row["duration_ms"] is not None
                    else None
                ),
                started_at=row["started_at"],
                completed_at=row["completed_at"],
                created_at=row["created_at"],
            )
            for row in rows
        ]
    except Exception as exc:
        bound.exception("cleanup_run_logs.query_error", error=str(exc))
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await pool.close()
