"""Tests for W3C trace-context propagation across the Redis DLQ (Issue #760).

The DLQ is an async queue in its own right: a payload can fail during one
request/task, sit in Redis, and only run again when an operator replays it
from a later, unrelated request. These tests exercise the trace_context
field added to DLQEntry, and confirm that a replayed payload's span rejoins
the ORIGINAL producer's trace instead of starting a new, disconnected one.

Async assertions use asyncio.run() inside plain ``def test_...`` functions
rather than ``@pytest.mark.asyncio`` — this suite's other async test module
(tests/test_anchor_status_poller.py) uses that marker, but pytest-asyncio
isn't declared anywhere in this repo's requirements or CI config, so relying
on it here would make these tests fail to run in exactly the environments
that need them most.
"""

import asyncio
import json

import pytest
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

import app.telemetry as telemetry
from app.queue.dlq import DLQEntry, RedisDLQ, RetryPolicy


class _FakePipeline:
    def rpush(self, *args, **kwargs):
        pass

    def ltrim(self, *args, **kwargs):
        pass

    async def execute(self):
        pass


class _FakeRedis:
    """Minimal stand-in so RedisDLQ.push() works without a real Redis."""

    def pipeline(self):
        return _FakePipeline()


@pytest.fixture
def traced():
    """Enable tracing with an in-memory exporter for the duration of a test."""
    import os

    os.environ["TRACING_ENABLED"] = "true"
    os.environ["TRACING_CONSOLE_EXPORTER"] = "false"
    try:
        import importlib

        importlib.reload(telemetry)
        provider = telemetry.setup_tracing()
        exporter = InMemorySpanExporter()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        yield telemetry.get_tracer("test"), exporter
    finally:
        telemetry.shutdown_tracing()
        os.environ.pop("TRACING_ENABLED", None)
        os.environ.pop("TRACING_CONSOLE_EXPORTER", None)


def test_backward_compatible_with_entries_stored_before_this_change():
    """A DLQEntry serialised by the pre-#760 code (no trace_context key)
    must still deserialise — Redis may hold entries written before this
    field existed."""
    legacy_json = json.dumps(
        {
            "entry_id": 1,
            "payload_b64": "aGVsbG8=",
            "error_type": "ValueError",
            "error_message": "boom",
            "traceback_str": "",
            "source": "ledger-stream",
            "attempt": 1,
            "max_attempts": 3,
            "enqueued_at": "2026-01-01T00:00:00+00:00",
            "next_retry_at": None,
            "permanently_failed": False,
        }
    )
    entry = DLQEntry.from_json(legacy_json)
    assert entry.trace_context is None


def test_create_captures_active_span_as_w3c_traceparent(traced):
    tracer, _exporter = traced
    with tracer.start_as_current_span("producer-span") as span:
        trace_id_hex = format(span.get_span_context().trace_id, "032x")
        entry = DLQEntry.create(
            entry_id=1,
            raw_payload=b"payload",
            exc=ValueError("boom"),
            source="ledger-stream",
            attempt=1,
            policy=RetryPolicy(max_attempts=3),
        )

    assert entry.trace_context is not None
    assert trace_id_hex in entry.trace_context["traceparent"]


def test_trace_context_round_trips_through_redis_json(traced):
    tracer, _exporter = traced
    with tracer.start_as_current_span("producer-span"):
        entry = DLQEntry.create(
            entry_id=1,
            raw_payload=b"payload",
            exc=ValueError("boom"),
            source="ledger-stream",
            attempt=1,
            policy=RetryPolicy(max_attempts=3),
        )

    restored = DLQEntry.from_json(entry.to_json())
    assert restored.trace_context == entry.trace_context


def test_replay_rejoins_the_original_producer_trace(traced):
    """The central guarantee: replaying a stored entry from an unrelated
    later request produces a span under the ORIGINAL trace ID, not a new
    disconnected one."""
    tracer, _exporter = traced

    from opentelemetry import trace as otel_trace

    observed_trace_id = {}

    async def processor(_payload):
        # Capture the trace ID the "dlq.process_payload" span is running
        # under, from inside the callback the DLQ invokes during replay.
        current_span_ctx = otel_trace.get_current_span().get_span_context()
        observed_trace_id["value"] = format(current_span_ctx.trace_id, "032x")

    async def scenario():
        with tracer.start_as_current_span("producer-span") as span:
            producer_trace_id = format(span.get_span_context().trace_id, "032x")
            entry = DLQEntry.create(
                entry_id=1,
                raw_payload=b"payload",
                exc=ValueError("boom"),
                source="ledger-stream",
                attempt=1,
                policy=RetryPolicy(max_attempts=3),
            )

        dlq = RedisDLQ.__new__(RedisDLQ)
        dlq._policy = RetryPolicy(max_attempts=3)
        dlq._seq_lock = asyncio.Lock()
        dlq._seq = entry.entry_id
        dlq._key = "test-dlq"
        dlq._max_size = 100
        dlq._redis = _FakeRedis()

        # A later, unrelated request replays the stored entry. Its own span
        # ("unrelated-admin-replay-request") must NOT be what the processor
        # runs under — only the restored trace_context should apply.
        with tracer.start_as_current_span("unrelated-admin-replay-request"):
            ok = await dlq.retry_with_backoff(
                entry.raw_payload,
                processor=processor,
                source=entry.source,
                trace_context=entry.trace_context,
            )
        assert ok
        return producer_trace_id

    producer_trace_id = asyncio.run(scenario())

    assert observed_trace_id.get("value") == producer_trace_id


def test_replay_without_trace_context_does_not_crash(traced):
    """Entries created before tracing was enabled (trace_context=None) must
    still replay successfully — propagation is best-effort, not required."""
    tracer, _exporter = traced

    async def scenario():
        dlq = RedisDLQ.__new__(RedisDLQ)
        dlq._policy = RetryPolicy(max_attempts=3)
        dlq._seq_lock = asyncio.Lock()
        dlq._seq = 1
        dlq._key = "test-dlq"
        dlq._max_size = 100
        dlq._redis = _FakeRedis()

        return await dlq.retry_with_backoff(
            b"payload",
            processor=lambda payload: asyncio.sleep(0),
            source="ledger-stream",
            trace_context=None,
        )

    assert asyncio.run(scenario()) is True