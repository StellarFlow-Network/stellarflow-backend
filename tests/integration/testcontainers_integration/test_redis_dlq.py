"""Redis DLQ integration tests — Dead-Letter Queue against a real Redis container.

Tests cover:
- Push entries to the DLQ
- List and filter entries
- Stats reporting
- Exponential backoff retry logic
- Purge operation
- REST inspect/replay handlers
- FIFO eviction on max_size overflow
"""

from __future__ import annotations

import asyncio
import json

import pytest

from app.queue.dlq import (
    DLQEntry,
    DLQStats,
    RedisDLQ,
    RetryPolicy,
    handle_dlq_inspect,
    handle_dlq_replay,
)

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_payload(data: str = "test-payload") -> bytes:
    return data.encode("utf-8")


# ---------------------------------------------------------------------------
# Core DLQ operations
# ---------------------------------------------------------------------------


class TestRedisDLQCore:
    """Test core DLQ push/list/stats/purge operations against real Redis."""

    async def test_push_and_list_entries(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq")
        dlq._redis = async_redis_client

        payload = _make_payload("entry-1")
        entry = await dlq.push(payload, exc=None, source="test", attempt=1)

        assert entry.entry_id == 1
        assert entry.source == "test"
        assert entry.raw_payload == payload
        assert entry.permanently_failed is False

        entries = await dlq.list_entries()
        assert len(entries) == 1
        assert entries[0].entry_id == 1

        await dlq.close()

    async def test_push_with_exception(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq:exc")
        dlq._redis = async_redis_client

        try:
            raise ValueError("something went wrong")
        except ValueError as exc:
            entry = await dlq.push(
                _make_payload("error-payload"),
                exc=exc,
                source="error-source",
                attempt=1,
            )

        assert entry.error_type == "ValueError"
        assert entry.error_message == "something went wrong"
        assert entry.permanently_failed is False

        await dlq.close()

    async def test_stats_empty(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq:empty")
        dlq._redis = async_redis_client

        stats = await dlq.stats()
        assert stats.total_entries == 0
        assert stats.pending_entries == 0
        assert stats.permanently_failed_entries == 0
        assert stats.oldest_entry_at is None

        await dlq.close()

    async def test_stats_after_push(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq:stats")
        dlq._redis = async_redis_client

        await dlq.push(_make_payload("a"), source="s1", attempt=1)
        await dlq.push(_make_payload("b"), source="s2", attempt=2)
        await dlq.push(
            _make_payload("c"),
            exc=RuntimeError("fail"),
            source="s3",
            attempt=3,
        )

        stats = await dlq.stats()
        assert stats.total_entries == 3
        assert stats.redis_key == "stellarflow:test:dlq:stats"
        assert stats.oldest_entry_at is not None
        assert stats.newest_entry_at is not None

        await dlq.close()

    async def test_purge(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq:purge")
        dlq._redis = async_redis_client

        for i in range(5):
            await dlq.push(_make_payload(f"item-{i}"), source="purge-test", attempt=1)

        count = await dlq.purge()
        assert count == 5

        entries = await dlq.list_entries()
        assert len(entries) == 0

        await dlq.close()

    async def test_list_entries_filtered(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq:filter")
        dlq._redis = async_redis_client

        await dlq.push(_make_payload("pending"), source="s", attempt=1)
        await dlq.push(
            _make_payload("failed"),
            exc=RuntimeError("boom"),
            source="s",
            attempt=3,
        )

        all_entries = await dlq.list_entries(include_permanently_failed=True)
        assert len(all_entries) == 2

        pending_only = await dlq.list_entries(include_permanently_failed=False)
        assert len(pending_only) == 1

        await dlq.close()

    async def test_get_entry_by_id(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq:getbyid")
        dlq._redis = async_redis_client

        entry = await dlq.push(_make_payload("findme"), source="s", attempt=1)

        found = await dlq.get_entry(entry.entry_id)
        assert found is not None
        assert found.entry_id == entry.entry_id

        not_found = await dlq.get_entry(99999)
        assert not_found is None

        await dlq.close()

    async def test_fifo_eviction(self, async_redis_client) -> None:
        dlq = RedisDLQ(
            redis_key="stellarflow:test:dlq:evict",
            max_size=3,
        )
        dlq._redis = async_redis_client

        for i in range(5):
            await dlq.push(_make_payload(f"item-{i}"), source="evict", attempt=1)

        entries = await dlq.list_entries()
        assert len(entries) == 3
        assert entries[0].raw_payload == _make_payload("item-2")
        assert entries[2].raw_payload == _make_payload("item-4")

        await dlq.close()


# ---------------------------------------------------------------------------
# Exponential backoff retry
# ---------------------------------------------------------------------------


class TestDLQRetryBackoff:
    """Test the retry_with_backoff method against real Redis."""

    async def test_retry_succeeds_on_first_attempt(self, async_redis_client) -> None:
        dlq = RedisDLQ(
            redis_key="stellarflow:test:dlq:retry:first",
            policy=RetryPolicy(max_attempts=3, base_delay_secs=0.01),
        )
        dlq._redis = async_redis_client

        call_count = 0

        async def processor(payload: bytes) -> None:
            nonlocal call_count
            call_count += 1

        result = await dlq.retry_with_backoff(
            _make_payload("ok"),
            processor,
            source="retry-test",
        )
        assert result is True
        assert call_count == 1
        await dlq.close()

    async def test_retry_succeeds_after_failures(self, async_redis_client) -> None:
        dlq = RedisDLQ(
            redis_key="stellarflow:test:dlq:retry:later",
            policy=RetryPolicy(max_attempts=3, base_delay_secs=0.01),
        )
        dlq._redis = async_redis_client

        call_count = 0

        async def processor(payload: bytes) -> None:
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise RuntimeError(f"attempt {call_count} failed")

        result = await dlq.retry_with_backoff(
            _make_payload("retry-ok"),
            processor,
            source="retry-test",
        )
        assert result is True
        assert call_count == 3
        await dlq.close()

    async def test_retry_exhausted(self, async_redis_client) -> None:
        dlq = RedisDLQ(
            redis_key="stellarflow:test:dlq:retry:exhaust",
            policy=RetryPolicy(max_attempts=2, base_delay_secs=0.01),
        )
        dlq._redis = async_redis_client

        async def always_fail(payload: bytes) -> None:
            raise RuntimeError("always fails")

        result = await dlq.retry_with_backoff(
            _make_payload("fail"),
            always_fail,
            source="exhaust-test",
        )
        assert result is False

        entries = await dlq.list_entries()
        assert len(entries) >= 2
        last = entries[-1]
        assert last.permanently_failed is True

        await dlq.close()


# ---------------------------------------------------------------------------
# REST handlers
# ---------------------------------------------------------------------------


class TestDLQRestHandlers:
    """Test the REST API handlers against real Redis."""

    async def test_inspect_handler(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq:inspect")
        dlq._redis = async_redis_client

        await dlq.push(_make_payload("inspect-me"), source="rest", attempt=1)

        result = await handle_dlq_inspect(dlq, {"start": 0, "end": 99})
        assert result["success"] is True
        assert result["stats"]["total_entries"] == 1
        assert len(result["entries"]) == 1

        await dlq.close()

    async def test_replay_handler_single_entry(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq:replay:single")
        dlq._redis = async_redis_client

        entry = await dlq.push(_make_payload("replay-me"), source="rest", attempt=1)

        processed = []

        async def processor(payload: bytes) -> None:
            processed.append(payload)

        result = await handle_dlq_replay(
            dlq, processor, {"entry_id": entry.entry_id}
        )
        assert result["success"] is True
        assert len(processed) == 1
        assert processed[0] == _make_payload("replay-me")

        await dlq.close()

    async def test_replay_handler_not_found(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq:replay:nf")
        dlq._redis = async_redis_client

        async def noop(payload: bytes) -> None:
            pass

        result = await handle_dlq_replay(dlq, noop, {"entry_id": 99999})
        assert result["success"] is False
        assert result["error"] == "NOT_FOUND"

        await dlq.close()

    async def test_replay_handler_all_pending(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq:replay:all")
        dlq._redis = async_redis_client

        for i in range(3):
            await dlq.push(_make_payload(f"item-{i}"), source="rest", attempt=1)

        processed = []

        async def processor(payload: bytes) -> None:
            processed.append(payload)

        result = await handle_dlq_replay(dlq, processor, {})
        assert result["success"] is True
        assert len(processed) == 3

        await dlq.close()

    async def test_replay_handler_purge_on_success(self, async_redis_client) -> None:
        dlq = RedisDLQ(redis_key="stellarflow:test:dlq:replay:purge")
        dlq._redis = async_redis_client

        for i in range(2):
            await dlq.push(_make_payload(f"item-{i}"), source="rest", attempt=1)

        async def processor(payload: bytes) -> None:
            pass

        result = await handle_dlq_replay(
            dlq, processor, {"purge_on_success": True}
        )
        assert result["success"] is True
        assert "purged" in result["message"]

        entries = await dlq.list_entries()
        assert len(entries) == 0

        await dlq.close()
