from datetime import datetime, timedelta, timezone

import pytest

from app.services.webhook_retry import (
    DISABLE_AFTER,
    MAX_WEBHOOK_ATTEMPTS,
    InMemoryEndpointStateStore,
    WebhookDelivery,
    WebhookEndpointHealth,
    WebhookRetryPolicy,
)


class FixedRandom:
    def uniform(self, _lower: int, _upper: int) -> int:
        return 0


def test_retry_policy_uses_bounded_exponential_backoff() -> None:
    policy = WebhookRetryPolicy(
        max_attempts=MAX_WEBHOOK_ATTEMPTS,
        base_delay_seconds=60,
        backoff_factor=2,
        max_delay_seconds=300,
        jitter_seconds=10,
    )

    assert [policy.delay_for_retry(attempt, FixedRandom()) for attempt in range(1, 6)] == [
        60,
        120,
        240,
        300,
        300,
    ]


def test_delivery_message_round_trips_and_validates_required_fields() -> None:
    delivery = WebhookDelivery(
        endpoint_id="endpoint-1",
        endpoint_url="https://example.test/webhook",
        event_id="event-1",
        payload={"type": "price.updated"},
        attempt=2,
    )

    assert WebhookDelivery.from_message(delivery.to_message()) == delivery
    with pytest.raises(ValueError):
        WebhookDelivery.from_message({"endpoint_id": "endpoint-1"})


@pytest.mark.asyncio
async def test_endpoint_is_disabled_after_continuous_failures_for_24_hours() -> None:
    health = WebhookEndpointHealth(InMemoryEndpointStateStore())
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)

    assert await health.record_failure("endpoint-1", start) is False
    assert await health.is_disabled("endpoint-1") is False
    assert await health.record_failure("endpoint-1", start + DISABLE_AFTER) is True
    assert await health.is_disabled("endpoint-1") is True


@pytest.mark.asyncio
async def test_success_resets_endpoint_failure_window() -> None:
    health = WebhookEndpointHealth(InMemoryEndpointStateStore())
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)

    await health.record_failure("endpoint-1", start)
    await health.record_success("endpoint-1")

    assert await health.is_disabled("endpoint-1") is False
    assert await health.record_failure("endpoint-1", start + timedelta(hours=23)) is False
