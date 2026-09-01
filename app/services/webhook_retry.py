"""Durable webhook delivery with Celery retries and endpoint health tracking.

The worker owns retry scheduling while Redis stores endpoint failure state so a
process restart cannot reset the 24-hour continuous-failure window.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol

import aiohttp

logger = logging.getLogger(__name__)

WEBHOOK_RETRY_QUEUE = "webhook.retry"
WEBHOOK_DLQ_QUEUE = "webhook.dead"
MAX_WEBHOOK_ATTEMPTS = 5
DISABLE_AFTER = timedelta(hours=24)
TRANSIENT_STATUS_CODES = frozenset({408, 425, 429, 500, 502, 503, 504})


@dataclass(frozen=True)
class WebhookRetryPolicy:
    max_attempts: int = MAX_WEBHOOK_ATTEMPTS
    base_delay_seconds: int = 60
    backoff_factor: int = 2
    max_delay_seconds: int = 3600
    jitter_seconds: int = 10

    def delay_for_retry(self, retry_number: int, rng: Any = random) -> int:
        """Return bounded exponential delay for retry number 1..N."""
        if retry_number < 1:
            raise ValueError("retry_number must be positive")
        delay = min(
            self.max_delay_seconds,
            self.base_delay_seconds * self.backoff_factor ** (retry_number - 1),
        )
        return max(0, int(delay + rng.uniform(0, self.jitter_seconds)))


@dataclass(frozen=True)
class WebhookDelivery:
    endpoint_id: str
    endpoint_url: str
    event_id: str
    payload: dict[str, Any]
    attempt: int = 0

    def to_message(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_message(cls, message: dict[str, Any]) -> "WebhookDelivery":
        required = ("endpoint_id", "endpoint_url", "event_id", "payload")
        if any(not message.get(field) for field in required):
            raise ValueError("webhook retry message is missing required fields")
        return cls(
            endpoint_id=str(message["endpoint_id"]),
            endpoint_url=str(message["endpoint_url"]),
            event_id=str(message["event_id"]),
            payload=dict(message["payload"]),
            attempt=int(message.get("attempt", 0)),
        )


class EndpointStateStore(Protocol):
    async def get(self, key: str) -> str | None: ...
    async def set(self, key: str, value: str, ex: int | None = None) -> Any: ...
    async def delete(self, key: str) -> Any: ...


class InMemoryEndpointStateStore:
    """Small test/local fallback; production deployments should use Redis."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    async def get(self, key: str) -> str | None:
        return self.values.get(key)

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.values[key] = value

    async def delete(self, key: str) -> None:
        self.values.pop(key, None)


class WebhookEndpointHealth:
    """Persists continuous failure state and disables endpoints after 24 hours."""

    def __init__(self, store: EndpointStateStore, prefix: str = "stellarflow:webhook:") -> None:
        self.store = store
        self.prefix = prefix

    def _key(self, endpoint_id: str) -> str:
        return f"{self.prefix}endpoint:{endpoint_id}"

    async def is_disabled(self, endpoint_id: str) -> bool:
        value = await self.store.get(self._key(endpoint_id))
        if not value:
            return False
        return bool(json.loads(value).get("disabled", False))

    async def record_failure(
        self,
        endpoint_id: str,
        now: datetime | None = None,
    ) -> bool:
        now = now or datetime.now(timezone.utc)
        key = self._key(endpoint_id)
        current = await self.store.get(key)
        state = json.loads(current) if current else {}
        first_failure = datetime.fromisoformat(state["first_failure_at"]) if state.get("first_failure_at") else now
        disabled = now - first_failure >= DISABLE_AFTER
        state.update({
            "first_failure_at": first_failure.isoformat(),
            "last_failure_at": now.isoformat(),
            "failure_count": int(state.get("failure_count", 0)) + 1,
            "disabled": disabled,
        })
        await self.store.set(key, json.dumps(state), ex=int(DISABLE_AFTER.total_seconds()))
        return disabled

    async def record_success(self, endpoint_id: str) -> None:
        await self.store.delete(self._key(endpoint_id))


async def deliver_webhook(
    delivery: WebhookDelivery,
    health: WebhookEndpointHealth,
    timeout_seconds: float = 10.0,
) -> int:
    """Deliver one webhook and return its HTTP status.

    Raises ``aiohttp`` or ``WebhookDeliveryError`` for failures so Celery can
    schedule the next durable retry.
    """
    if await health.is_disabled(delivery.endpoint_id):
        raise WebhookDeliveryError("webhook endpoint is disabled")

    timeout = aiohttp.ClientTimeout(total=timeout_seconds)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            delivery.endpoint_url,
            json=delivery.payload,
            headers={"Content-Type": "application/json", "X-Webhook-Event-Id": delivery.event_id},
        ) as response:
            status = response.status
            await response.read()

    if 200 <= status < 300:
        await health.record_success(delivery.endpoint_id)
        return status

    disabled = await health.record_failure(delivery.endpoint_id)
    if disabled:
        raise WebhookDeliveryError("webhook endpoint disabled after 24 hours of failures")
    if status not in TRANSIENT_STATUS_CODES:
        raise PermanentWebhookDeliveryError(f"webhook returned permanent HTTP {status}")
    raise WebhookDeliveryError(f"webhook returned transient HTTP {status}")


class WebhookDeliveryError(RuntimeError):
    """Transient delivery failure eligible for another attempt."""


class PermanentWebhookDeliveryError(RuntimeError):
    """Permanent delivery failure that must go to the terminal DLQ."""


def queue_webhook_retry(delivery: WebhookDelivery) -> Any:
    """Enqueue a durable retry through the registered Celery task."""
    from app.tasks import deliver_webhook_task

    return deliver_webhook_task.apply_async(
        kwargs={"message": delivery.to_message()},
        queue=WEBHOOK_RETRY_QUEUE,
    )


def run_delivery(
    delivery: WebhookDelivery,
    health: WebhookEndpointHealth,
    timeout_seconds: float,
) -> int:
    return asyncio.run(deliver_webhook(delivery, health, timeout_seconds))
