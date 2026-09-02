"""Poll anchor settlement status and publish completed remittances.

The worker is deliberately idempotent: the database update includes the
``pending_external`` predicate, so a retry cannot emit a second completion
event after another worker has already claimed the transition.
"""

import json
import os
from typing import Any, Awaitable, Callable, Mapping
from urllib.parse import quote

import aiohttp
import asyncpg
import redis.asyncio as aioredis
import structlog

log = structlog.get_logger(__name__)

PENDING_EXTERNAL = "pending_external"
COMPLETED = "COMPLETED"
POLLABLE_STATUSES = {"completed", "complete", "delivered", "settled", "success"}


def extract_status(payload: Mapping[str, Any]) -> str | None:
    """Extract and normalize a SEP-24/SEP-31 transaction status."""
    transaction = payload.get("transaction")
    value: Any = transaction.get("status") if isinstance(transaction, Mapping) else payload.get("status")
    if not isinstance(value, str):
        return None
    return value.strip().lower() or None


def is_completed_status(status: str | None) -> bool:
    return status in POLLABLE_STATUSES


class AnchorStatusPoller:
    """Poll active anchor payouts and publish completed status changes."""

    def __init__(
        self,
        database_url: str | None = None,
        redis_url: str | None = None,
        http_session_factory: Callable[..., Any] = aiohttp.ClientSession,
        pool_factory: Callable[..., Awaitable[Any]] = asyncpg.create_pool,
        redis_factory: Callable[..., Any] = aioredis.from_url,
    ) -> None:
        self.database_url = database_url or os.getenv("DATABASE_URL") or os.getenv("DB_URL")
        self.redis_url = redis_url or os.getenv("REDIS_URL", "redis://localhost:6379")
        self.http_session_factory = http_session_factory
        self.pool_factory = pool_factory
        self.redis_factory = redis_factory

    async def poll_once(self) -> int:
        """Process one bounded batch of pending external settlements."""
        if not self.database_url:
            raise RuntimeError("DATABASE_URL or DB_URL must be configured")

        pool = await self.pool_factory(self.database_url, min_size=1, max_size=5)
        redis = self.redis_factory(self.redis_url, decode_responses=True)
        completed = 0
        try:
            async with pool.acquire() as connection:
                rows = await connection.fetch(
                    '''
                    SELECT id, reference, provider
                    FROM "RemittanceTransaction"
                    WHERE status = $1 AND reference IS NOT NULL
                    ORDER BY "updatedAt" ASC
                    LIMIT 100
                    ''',
                    PENDING_EXTERNAL,
                )
                async with self.http_session_factory() as session:
                    for row in rows:
                        try:
                            status = await self.fetch_status(
                                session,
                                str(row["provider"] or ""),
                                str(row["reference"]),
                            )
                            if not is_completed_status(status):
                                continue
                            changed = await self.mark_completed(connection, str(row["id"]))
                            if changed:
                                await self.publish(redis, str(row["id"]))
                                completed += 1
                        except Exception:
                            log.exception(
                                "anchor_poller.row_failed",
                                component="AnchorStatusPoller",
                                remittance_id=str(row["id"]),
                            )
            log.info(
                "anchor_poller.poll_completed",
                component="AnchorStatusPoller",
                completed_count=completed,
            )
            return completed
        finally:
            await pool.close()
            await redis.close()

    async def fetch_status(self, session: Any, provider: str, reference: str) -> str | None:
        """Fetch a status from the configured SEP-24 or SEP-31 status API."""
        protocol = "sep31" if "sep31" in provider.lower() else "sep24"
        endpoint = os.getenv(f"ANCHOR_{protocol.upper()}_STATUS_URL") or os.getenv("ANCHOR_STATUS_URL")
        if not endpoint:
            log.warning(
                "anchor_poller.no_status_endpoint",
                component="AnchorStatusPoller",
                protocol=protocol,
            )
            return None

        if protocol == "sep31":
            url = f"{endpoint.rstrip('/')}/transactions/{quote(reference, safe='')}"
            request = session.get(url)
        else:
            request = session.get(endpoint, params={"id": reference})

        async with request as response:
            response.raise_for_status()
            return extract_status(await response.json())

    async def mark_completed(self, connection: Any, transaction_id: str) -> bool:
        """Transition exactly one still-pending transaction."""
        result = await connection.execute(
            '''
            UPDATE "RemittanceTransaction"
            SET status = $1, "updatedAt" = CURRENT_TIMESTAMP
            WHERE id = $2 AND status = $3
            ''',
            COMPLETED,
            transaction_id,
            PENDING_EXTERNAL,
        )
        return result.endswith("1")

    async def publish(self, redis: Any, transaction_id: str) -> None:
        await redis.publish(
            f"remittance_{transaction_id}",
            json.dumps(
                {
                    "transaction_id": transaction_id,
                    "status": COMPLETED,
                    "event": "STATUS_UPDATE",
                }
            ),
        )
