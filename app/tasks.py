"""Distributed tasks for heavy StellarFlow analytics and document workloads."""

import asyncio
import hashlib
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import asyncpg
from celery import Task

from app.celery_app import celery_app
from app.services.anchor_status_poller import AnchorStatusPoller
from app.services.webhook_retry import (
    InMemoryEndpointStateStore,
    WebhookDelivery,
    WebhookEndpointHealth,
    WebhookDeliveryError,
    PermanentWebhookDeliveryError,
    WEBHOOK_DLQ_QUEUE,
    run_delivery,
)

class DatabaseTask(Task):
    """Base task that exposes the configured PostgreSQL connection string."""

    _database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))


@celery_app.task(
    bind=True,
    base=DatabaseTask,
    name="app.tasks.poll_anchor_settlement_statuses",
    autoretry_for=(OSError, asyncpg.PostgresError),
    retry_backoff=True,
    max_retries=3,
)
def poll_anchor_settlement_statuses(self: DatabaseTask) -> int:
    """Poll SEP-24/SEP-31 payout statuses and notify WebSocket subscribers."""
    return asyncio.run(AnchorStatusPoller().poll_once())


async def _aggregate(granularity: str, cutoff: datetime) -> int:
    database_url = DatabaseTask._database_url
    if not database_url:
        raise RuntimeError("DATABASE_URL or DB_URL must be configured")

    interval = {"MINUTE": "minute", "HOUR": "hour", "DAY": "day"}[granularity]
    pool = await asyncpg.create_pool(database_url)
    try:
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                f"""
                SELECT currency,
                       date_trunc('{interval}', timestamp) AS open_time,
                       min(rate) AS low,
                       max(rate) AS high,
                       (array_agg(rate ORDER BY timestamp, id))[1] AS open,
                       (array_agg(rate ORDER BY timestamp DESC, id DESC))[1] AS close,
                       count(*)::int AS count
                FROM "PriceHistory"
                WHERE timestamp >= $1
                GROUP BY currency, date_trunc('{interval}', timestamp)
                """,
                cutoff,
            )

            updated = 0
            for row in rows:
                await connection.execute(
                    """
                    INSERT INTO "OhlcCandle"
                      (currency, granularity, "openTime", "closeTime", open, high, low, close, count)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (currency, granularity, "openTime") DO UPDATE SET
                      "closeTime" = EXCLUDED."closeTime",
                      open = EXCLUDED.open,
                      high = EXCLUDED.high,
                      low = EXCLUDED.low,
                      close = EXCLUDED.close,
                      count = EXCLUDED.count,
                      "updatedAt" = CURRENT_TIMESTAMP
                    """,
                    row["currency"],
                    granularity,
                    row["open_time"],
                    row["open_time"] + timedelta(minutes={"MINUTE": 1, "HOUR": 60, "DAY": 1440}[granularity]),
                    row["open"],
                    row["high"],
                    row["low"],
                    row["close"],
                    row["count"],
                )
                updated += 1
            return updated
    finally:
        await pool.close()


@celery_app.task(
    bind=True,
    base=DatabaseTask,
    name="app.tasks.aggregate_ledger_analytics",
    autoretry_for=(OSError, asyncpg.PostgresError),
    retry_backoff=True,
    max_retries=3,
)
def aggregate_ledger_analytics(
    self: DatabaseTask,
    granularity: str = "HOUR",
    lookback_hours: int = 25,
) -> int:
    """Aggregate recent ledger price history into idempotent OHLC candles."""
    if granularity not in {"MINUTE", "HOUR", "DAY"}:
        raise ValueError("granularity must be MINUTE, HOUR, or DAY")
    if lookback_hours < 1:
        raise ValueError("lookback_hours must be positive")

    DatabaseTask._database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=lookback_hours)
    return asyncio.run(_aggregate(granularity, cutoff))


# ---------------------------------------------------------------------------
# User activity CSV export (S3)
# ---------------------------------------------------------------------------


async def _export_user_activity(user_id: str) -> dict[str, object]:
    database_url = DatabaseTask._database_url
    if not database_url:
        raise RuntimeError("DATABASE_URL or DB_URL must be configured")

    from app.services.user_activity_export import export_user_activity

    pool = await asyncpg.create_pool(database_url)
    try:
        async with pool.acquire() as connection:
            async with connection.transaction():
                rows = connection.cursor(
                    """
                    SELECT event_hash, ledger_sequence, tx_hash, event_type,
                           created_at, payload
                    FROM ledger_events
                    WHERE payload->>'user_id' = $1
                    ORDER BY created_at ASC, event_hash ASC
                    """,
                    user_id,
                )
                return await export_user_activity(rows, user_id)
    finally:
        await pool.close()


# ---------------------------------------------------------------------------
# Flash-loan revenue accounting tasks
# ---------------------------------------------------------------------------


def _event_id(tx_hash: str, event_index: int) -> str:
    """Deterministic dedup key for a flash-loan revenue event."""
    raw = f"{tx_hash}:{event_index}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _snapshot_id(granularity: str, window_start: datetime) -> str:
    """Deterministic dedup key for a yield snapshot."""
    raw = f"{granularity}:{window_start.isoformat()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _parse_flash_loan_event(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Parse a raw Soroban ledger event into flash-loan revenue fields.

    Returns ``None`` when the payload is not a ``FlashLoanFeesDistributed``
    event or when required fields are missing.
    """
    event_type = payload.get("topic") or payload.get("type") or ""
    if "FlashLoanFeesDistributed" not in str(event_type):
        return None

    tx_hash = payload.get("txHash", "0x0")
    event_index = int(payload.get("index", 0))

    amount = payload.get("amount")
    treasury_account = payload.get("treasury") or payload.get("treasury_account")
    block_time = payload.get("blockTime") or payload.get("ledger_close_time")

    if isinstance(block_time, (int, float)):
        try:
            block_time = datetime.fromtimestamp(block_time, tz=timezone.utc)
        except (OSError, ValueError, OverflowError):
            block_time = None
    elif isinstance(block_time, str):
        try:
            block_time = datetime.fromisoformat(block_time.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            block_time = None

    if amount is None or treasury_account is None:
        return None

    return {
        "id": _event_id(str(tx_hash), event_index),
        "ledger_sequence": int(payload.get("ledger", 0)),
        "tx_hash": str(tx_hash),
        "event_index": event_index,
        "amount": amount,
        "treasury_account": str(treasury_account),
        "block_time": block_time,
        "payload": payload,
    }


def _safe_numeric(value: Any) -> Optional[float]:
    """Coerce *value* to a float suitable for SQL ``NUMERIC`` binding."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


async def _ingest_flash_loan_events(lookback_minutes: int = 60) -> int:
    """Scan recent ``ledger_events`` for ``FlashLoanFeesDistributed`` events
    and persist any new rows into ``flash_loan_revenue``."""
    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=lookback_minutes)
    pool = await asyncpg.create_pool(database_url)
    try:
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT event_hash, ledger_sequence, tx_hash, event_type, payload, created_at
                FROM ledger_events
                WHERE created_at >= $1
                  AND event_type = 'contract'
                ORDER BY created_at ASC
                """,
                cutoff,
            )

            inserted = 0
            for row in rows:
                payload = row["payload"]
                if not isinstance(payload, dict):
                    continue

                parsed = _parse_flash_loan_event(payload)
                if parsed is None:
                    continue

                try:
                    await connection.execute(
                        """
                        INSERT INTO flash_loan_revenue (
                            id, ledger_sequence, tx_hash, event_index,
                            amount, treasury_account, block_time, payload
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        ON CONFLICT (id) DO NOTHING
                        """,
                        parsed["id"],
                        parsed["ledger_sequence"],
                        parsed["tx_hash"],
                        parsed["event_index"],
                        _safe_numeric(parsed["amount"]),
                        parsed["treasury_account"],
                        parsed["block_time"],
                        parsed["payload"],
                    )
                    inserted += 1
                except Exception:
                    continue

            return inserted
    finally:
        await pool.close()


@celery_app.task(
    bind=True,
    base=DatabaseTask,
    name="app.tasks.ingest_flash_loan_revenue",
    autoretry_for=(OSError, asyncpg.PostgresError),
    retry_backoff=True,
    max_retries=3,
)
def ingest_flash_loan_revenue(
    self: DatabaseTask,
    lookback_minutes: int = 60,
) -> int:
    """Ingest ``FlashLoanFeesDistributed`` events from ``ledger_events``."""
    DatabaseTask._database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    if lookback_minutes < 1:
        raise ValueError("lookback_minutes must be positive")
    return int(asyncio.run(_ingest_flash_loan_events(lookback_minutes)))


async def _compute_yield_snapshots(granularity: str = "DAILY") -> int:
    """Aggregate ``flash_loan_revenue`` into ``protocol_yield_snapshot`` rows."""
    database_url = DatabaseTask._database_url
    if not database_url:
        raise RuntimeError("DATABASE_URL or DB_URL must be configured")

    now = datetime.now(timezone.utc).replace(tzinfo=None)

    if granularity == "HOURLY":
        window = timedelta(hours=1)
        lookback = timedelta(hours=26)
    elif granularity == "DAILY":
        window = timedelta(days=1)
        lookback = timedelta(days=2)
    else:
        raise ValueError("granularity must be HOURLY or DAILY")

    cutoff = now - lookback
    pool = await asyncpg.create_pool(database_url)
    try:
        async with pool.acquire() as connection:
            rows = await connection.fetch(
                """
                SELECT
                    date_trunc('hour', created_at) AS window_start,
                    COUNT(*) AS event_count,
                    SUM(amount) AS total_revenue,
                    SUM(amount) AS fee_volume
                FROM flash_loan_revenue
                WHERE created_at >= $1
                GROUP BY 1
                ORDER BY 1 ASC
                """,
                cutoff,
            )

            inserted = 0
            for row in rows:
                window_start_dt: datetime = row["window_start"]
                window_end_dt = window_start_dt + window

                if granularity == "DAILY":
                    window_start_dt = window_start_dt.replace(
                        hour=0, minute=0, second=0, microsecond=0
                    )
                    window_end_dt = window_start_dt + timedelta(days=1)

                snapshot_id = _snapshot_id(granularity, window_start_dt)
                total_revenue = _safe_numeric(row["total_revenue"]) or 0.0
                event_count = int(row["event_count"] or 0)
                fee_volume = _safe_numeric(row["fee_volume"]) or 0.0

                try:
                    await connection.execute(
                        """
                        INSERT INTO protocol_yield_snapshot (
                            id, granularity, window_start, window_end,
                            total_flash_loan_revenue, total_treasury_balance,
                            yield_apy, fee_volume, event_count
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                        ON CONFLICT (id) DO NOTHING
                        """,
                        snapshot_id,
                        granularity,
                        window_start_dt,
                        window_end_dt,
                        total_revenue,
                        None,
                        None,
                        fee_volume,
                        event_count,
                    )
                    inserted += 1
                except Exception:
                    continue

            return inserted
    finally:
        await pool.close()


@celery_app.task(
    bind=True,
    base=DatabaseTask,
    name="app.tasks.ingest_flash_loan_revenue",
    autoretry_for=(OSError, asyncpg.PostgresError),
    retry_backoff=True,
    max_retries=3,
)
def compute_yield_snapshots(
    self: DatabaseTask,
    granularity: str = "DAILY",
) -> int:
    """Compute aggregate protocol yield snapshots from ``flash_loan_revenue``."""
    DatabaseTask._database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    if granularity not in {"HOURLY", "DAILY"}:
        raise ValueError("granularity must be HOURLY or DAILY")
    return int(asyncio.run(_compute_yield_snapshots(granularity)))


# ---------------------------------------------------------------------------
# Issue #772 — Asynchronous PDF payment receipt generation
# ---------------------------------------------------------------------------

_RECEIPT_QUERY = """
    SELECT id, "userId", asset, "senderCurrency", "receiverCurrency",
           amount, "outputAmount", fee, rate, status, provider,
           "stellarTxHash", reference, "errorMessage", "createdAt", "updatedAt"
    FROM "RemittanceTransaction"
    WHERE id = $1 AND status = 'COMPLETED'
"""


async def _fetch_completed_transaction(
    pool: Any, transaction_id: str
) -> Optional[Dict[str, Any]]:
    async with pool.acquire() as connection:
        rows = await connection.fetch(_RECEIPT_QUERY, transaction_id)
    return dict(rows[0]) if rows else None


async def _receipt_for_transaction(
    transaction_id: str, user_id: str | None = None
) -> dict[str, object]:
    """Fetch a completed remittance transaction and generate its receipt PDF."""
    database_url = DatabaseTask._database_url
    if not database_url:
        raise RuntimeError("DATABASE_URL or DB_URL must be configured")

    if not user_id:
        raise ValueError(
            "user_id is required to generate a payment receipt for "
            "transactions not owned by the authenticated caller"
        )

    pool = await asyncpg.create_pool(database_url)
    try:
        row = await _fetch_completed_transaction(pool, transaction_id)
    finally:
        await pool.close()

    if row is None:
        raise LookupError(
            f"transaction {transaction_id!r} either does not exist or is not COMPLETED"
        )

    if row.get("userId") != user_id:
        raise PermissionError(
            f"transaction {transaction_id!r} does not belong to user {user_id!r}"
        )

    receipt_data = {
        "transaction_id": transaction_id,
        "user_id": user_id,
        "asset": row.get("asset"),
        "amount": row.get("amount"),
        "sender_currency": row.get("senderCurrency"),
        "receiver_currency": row.get("receiverCurrency"),
        "output_amount": row.get("outputAmount"),
        "fee": row.get("fee") or 0,
        "rate": row.get("rate"),
        "status": row.get("status") or "COMPLETED",
        "provider": row.get("provider"),
        "reference": row.get("reference"),
        "stellar_tx_hash": row.get("stellarTxHash"),
        "completed_at": _iso_or_none(row.get("updatedAt")) or _iso_or_none(row.get("createdAt")),
    }
    return generate_payment_receipt(receipt_data)


def _iso_or_none(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        return value
    return None


@celery_app.task(
    bind=True,
    base=DatabaseTask,
    name="app.tasks.export_user_activity_csv",
    autoretry_for=(OSError, asyncpg.PostgresError),
    retry_backoff=True,
    max_retries=3,
)
def generate_payment_receipt_task(
    self: DatabaseTask,
    transaction_id: str,
    user_id: str,
    recipient_email: str | None = None,
) -> dict[str, object]:
    """Render, store and notify a PDF receipt for a completed payout.

    Compiles the Jinja2 receipt template to a PDF (WeasyPrint), uploads the
    document to S3 and sends a signed download link through the configured
    email / webhook notification handlers.
    """
    if not isinstance(transaction_id, str) or not transaction_id.strip():
        raise ValueError("transaction_id must be a non-empty string")
    if not isinstance(user_id, str) or not user_id.strip():
        raise ValueError("user_id must be a non-empty string")

    DatabaseTask._database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    return asyncio.run(_export_user_activity(user_id.strip()))


@celery_app.task(
    bind=True,
    base=DatabaseTask,
    name="app.tasks.compute_yield_snapshots",
    autoretry_for=(OSError, asyncpg.PostgresError),
    retry_backoff=True,
    max_retries=3,
)
def compute_yield_snapshots(
    self: DatabaseTask,
    granularity: str = "DAILY",
) -> int:
    """Compute aggregate protocol yield snapshots from ``flash_loan_revenue``."""
    DatabaseTask._database_url = os.getenv("DATABASE_URL", os.getenv("DB_URL"))
    if granularity not in {"HOURLY", "DAILY"}:
        raise ValueError("granularity must be HOURLY or DAILY")
    return int(asyncio.run(_compute_yield_snapshots(granularity)))


_webhook_health_store = InMemoryEndpointStateStore()


def _webhook_health() -> WebhookEndpointHealth:
    """Build endpoint health storage, preferring the configured Redis backend."""
    redis_url = os.getenv("WEBHOOK_REDIS_URL") or os.getenv("REDIS_URL")
    if not redis_url:
        return WebhookEndpointHealth(_webhook_health_store)

    import redis.asyncio as redis

    return WebhookEndpointHealth(redis.from_url(redis_url, decode_responses=True))


def _webhook_retry_policy():
    from app.services.webhook_retry import WebhookRetryPolicy

    return WebhookRetryPolicy(
        max_attempts=5,
        base_delay_seconds=int(os.getenv("WEBHOOK_RETRY_BASE_SECONDS", "60")),
        backoff_factor=int(os.getenv("WEBHOOK_RETRY_BACKOFF_FACTOR", "2")),
        max_delay_seconds=int(os.getenv("WEBHOOK_RETRY_MAX_SECONDS", "3600")),
        jitter_seconds=int(os.getenv("WEBHOOK_RETRY_JITTER_SECONDS", "10")),
    )


@celery_app.task(
    bind=True,
    name="app.tasks.deliver_webhook_task",
    max_retries=4,
    acks_late=True,
    reject_on_worker_lost=True,
)
def deliver_webhook_task(self: Task, message: dict[str, object]) -> int:
    """Deliver a webhook, retrying transient failures up to five total attempts."""
    delivery = WebhookDelivery.from_message(message)
    delivery = WebhookDelivery(
        endpoint_id=delivery.endpoint_id,
        endpoint_url=delivery.endpoint_url,
        event_id=delivery.event_id,
        payload=delivery.payload,
        attempt=self.request.retries + 1,
    )
    health = _webhook_health()

    try:
        return run_delivery(
            delivery,
            health,
            timeout_seconds=float(os.getenv("WEBHOOK_TIMEOUT_SECONDS", "10")),
        )
    except PermanentWebhookDeliveryError as error:
        webhook_dead_letter_task.apply_async(
            kwargs={"message": delivery.to_message(), "reason": str(error)},
            queue=WEBHOOK_DLQ_QUEUE,
        )
        raise
    except WebhookDeliveryError as error:
        if self.request.retries >= 4:
            webhook_dead_letter_task.apply_async(
                kwargs={"message": delivery.to_message(), "reason": str(error)},
                queue=WEBHOOK_DLQ_QUEUE,
            )
            raise
        raise self.retry(
            exc=error,
            countdown=_webhook_retry_policy().delay_for_retry(delivery.attempt),
        )
    except Exception as error:
        if self.request.retries >= 4:
            webhook_dead_letter_task.apply_async(
                kwargs={"message": delivery.to_message(), "reason": "unexpected delivery failure"},
                queue=WEBHOOK_DLQ_QUEUE,
            )
            raise
        raise self.retry(
            exc=error,
            countdown=_webhook_retry_policy().delay_for_retry(delivery.attempt),
        )


@celery_app.task(name="app.tasks.webhook_dead_letter_task")
def webhook_dead_letter_task(message: dict[str, object], reason: str) -> None:
    """Terminal webhook DLQ consumer hook for operator inspection/replay."""
    import logging

    logging.getLogger(__name__).error(
        "Webhook delivery moved to terminal DLQ endpoint_id=%s event_id=%s reason=%s",
        message.get("endpoint_id"),
        message.get("event_id"),
        reason,
    )
