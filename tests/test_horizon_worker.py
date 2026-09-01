"""Tests for src/ingestion/horizon_worker.py.

WebSocket and Redis are mocked so the suite runs without network / daemon
dependencies.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from typing import Dict, List

import pytest

from _horizon_xdr_encoder import build_v1_envelope
from ingestion.horizon_worker import (
    HorizonLedgerWorker,
    ReconnectPolicy,
    RedisStreamPublisher,
)
from tests_helpers import RecordingRedis, fake_connect

_ENVELOPE_B64 = base64.b64encode(
    build_v1_envelope([{"type": 1, "dest": b"\x44" * 32, "amount": 100}])
).decode()


def _notification() -> str:
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "method": "subscribe",
            "params": {
                "subscription": 1,
                "result": {
                    "type": "transaction",
                    "ledger": 12345,
                    "transactionHash": "0xabc",
                    "envelopeXdr": _ENVELOPE_B64,
                    "closedAt": "2026-08-30T12:00:00Z",
                },
            },
        }
    )


def _publisher(fake: RecordingRedis, batch_size: int = 10) -> RedisStreamPublisher:
    return RedisStreamPublisher(redis_client=fake, batch_size=batch_size, flush_interval_secs=0)


# ---------------------------------------------------------------------------
# ReconnectPolicy
# ---------------------------------------------------------------------------


class TestReconnectPolicy:
    def test_exponential_growth(self):
        policy = ReconnectPolicy(base_delay_secs=1.0, backoff_factor=2.0, max_delay_secs=60.0, jitter=0)
        assert policy.delay_for(1) == 1.0
        assert policy.delay_for(2) == 2.0
        assert policy.delay_for(3) == 4.0

    def test_ceiling_capped(self):
        policy = ReconnectPolicy(base_delay_secs=10.0, backoff_factor=4.0, max_delay_secs=100.0, jitter=0)
        assert policy.delay_for(1) == 10.0
        assert policy.delay_for(3) == 100.0  # 10 * 16 = 160 -> capped
        assert policy.delay_for(99) == 100.0

    def test_jitter_stays_in_bounds(self):
        policy = ReconnectPolicy(base_delay_secs=5.0, backoff_factor=2.0, max_delay_secs=60.0, jitter=0.5)
        for attempt in (1, 2, 3, 10):
            delay = policy.delay(attempt)
            ceiling = policy.delay_for(attempt)
            assert 0 <= delay <= ceiling

    def test_jitter_zero_is_deterministic(self):
        policy = ReconnectPolicy(jitter=0, base_delay_secs=2.0, max_delay_secs=10.0)
        assert policy.delay(3) == policy.delay_for(3)

    def test_validation(self):
        with pytest.raises(ValueError):
            ReconnectPolicy(base_delay_secs=-1)
        with pytest.raises(ValueError):
            ReconnectPolicy(backoff_factor=0.5)
        with pytest.raises(ValueError):
            ReconnectPolicy(max_delay_secs=1, base_delay_secs=5)
        with pytest.raises(ValueError):
            ReconnectPolicy(jitter=1.5)

    def test_exhausted(self):
        # `max_attempts = 3` gives up once the 3rd attempt is reached.
        policy = ReconnectPolicy(max_attempts=3)
        assert not policy.exhausted(0)
        assert not policy.exhausted(1)
        assert not policy.exhausted(2)
        assert policy.exhausted(3)
        assert policy.exhausted(4)


# ---------------------------------------------------------------------------
# RedisStreamPublisher
# ---------------------------------------------------------------------------


class TestRedisStreamPublisher:
    @pytest.mark.asyncio
    async def test_flushes_when_batch_full(self):
        fake = RecordingRedis()
        publisher = _publisher(fake, batch_size=3)
        await publisher.connect()
        await publisher.publish({"sequence_number": 1})
        await publisher.publish({"sequence_number": 2})
        assert fake.entries == []
        await publisher.publish({"sequence_number": 3})
        assert len(fake.entries) == 3
        assert publisher.stats()["batches"] == 1
        assert publisher.stats()["published"] == 3
        await publisher.close()

    @pytest.mark.asyncio
    async def test_explicit_flush(self):
        fake = RecordingRedis()
        publisher = _publisher(fake, batch_size=100)
        await publisher.connect()
        await publisher.publish({"sequence_number": 1})
        await publisher.publish({"sequence_number": 2})
        assert fake.entries == []
        flushed = await publisher.flush()
        assert flushed == 2
        assert len(fake.entries) == 2
        await publisher.close()

    @pytest.mark.asyncio
    async def test_publishes_json_payload_field(self):
        fake = RecordingRedis()
        publisher = _publisher(fake, batch_size=1)
        await publisher.connect()
        await publisher.publish({"sequence_number": 42, "event_type": "ledger"})
        fields = fake.entries[0]
        assert fields["type"] == "horizon ledger event"
        assert fields["source"] == "horizon-rpc-stream"
        assert fields["sequence_number"] == "42"
        payload = json.loads(fields["payload"])
        assert payload["sequence_number"] == 42
        assert payload["event_type"] == "ledger"
        await publisher.close()

    @pytest.mark.asyncio
    async def test_close_flushes_pending(self):
        fake = RecordingRedis()
        publisher = _publisher(fake, batch_size=100)
        await publisher.connect()
        await publisher.publish({"sequence_number": 7})
        await publisher.close()
        assert len(fake.entries) == 1
        assert fake.closed is True

    @pytest.mark.asyncio
    async def test_publish_after_close_raises(self):
        fake = RecordingRedis()
        publisher = _publisher(fake, batch_size=1)
        await publisher.connect()
        await publisher.close()
        with pytest.raises(RuntimeError):
            await publisher.publish({"sequence_number": 1})

    @pytest.mark.asyncio
    async def test_batched_upload_uses_stream_and_maxlen_kwargs(self):
        fake = RecordingRedis()
        publisher = RedisStreamPublisher(
            redis_client=fake,
            stream_key="custom:stream",
            batch_size=2,
            flush_interval_secs=0,
        )
        await publisher.connect()
        await publisher.publish({"a": 1})
        await publisher.publish({"a": 2})
        assert fake.calls[0]["stream"] == "custom:stream"
        assert fake.calls[0]["maxlen"] == 100000
        assert fake.calls[0]["approximate"] is True
        await publisher.close()

    @pytest.mark.asyncio
    async def test_validation(self):
        with pytest.raises(ValueError):
            RedisStreamPublisher(batch_size=0)
        with pytest.raises(ValueError):
            RedisStreamPublisher(maxlen=0)

    @pytest.mark.asyncio
    async def test_missing_redis_raises_runtime_error(self, monkeypatch):
        publisher = RedisStreamPublisher(redis_client=None, redis_url="redis://localhost:1/0")
        import redis as real_redis_module

        monkeypatch.setitem(sys.modules, "redis.asyncio", None)
        monkeypatch.setitem(sys.modules, "redis", real_redis_module)
        with pytest.raises(RuntimeError):
            await publisher.connect()


# ---------------------------------------------------------------------------
# Worker — stream publishing
# ---------------------------------------------------------------------------


class TestWorkerStreaming:
    @pytest.mark.asyncio
    async def test_stream_once_publishes_ledger_event(self, monkeypatch):
        fake = RecordingRedis()
        publisher = _publisher(fake, batch_size=1)
        worker = HorizonLedgerWorker(ws_url="wss://example.invalid/ws", publisher=publisher)
        ack = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"subscription": 0}})
        transaction = json.dumps(
            {
                "jsonrpc": "2.0",
                "method": "subscribe",
                "params": {
                    "subscription": 0,
                    "result": {"type": "transaction", "ledger": 9000, "transactionHash": "0x99", "envelopeXdr": _ENVELOPE_B64},
                },
            }
        )
        connect_fn, calls, _last = fake_connect([ack, transaction])
        monkeypatch.setattr("ingestion.horizon_worker._ws_connect", connect_fn)

        await worker._stream_once()
        assert calls["connections"] == 1
        assert len(fake.entries) == 1
        payload = json.loads(fake.entries[0]["payload"])
        assert payload["sequence_number"] == 9000
        assert payload["operation_logs"][0]["type_name"] == "PAYMENT"

    @pytest.mark.asyncio
    async def test_stream_once_records_sent_subscriptions(self, monkeypatch):
        fake = RecordingRedis()
        publisher = _publisher(fake, batch_size=1)
        worker = HorizonLedgerWorker(ws_url="wss://example.invalid/ws", publisher=publisher)
        ack = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"subscription": 0}})
        connect_fn, _calls, last = fake_connect([ack])
        monkeypatch.setattr("ingestion.horizon_worker._ws_connect", connect_fn)

        await worker._stream_once()
        sent = last["ws"].sent
        assert len(sent) == 3
        for payload in sent:
            assert json.loads(payload)["method"] == "subscribe"
        assert {json.loads(payload)["params"]["type"] for payload in sent} == {
            "ledgers",
            "transactions",
            "events",
        }
        # no events published for an ack-only stream
        assert fake.entries == []

    @pytest.mark.asyncio
    async def test_stream_once_does_not_publish_acks(self, monkeypatch):
        fake = RecordingRedis()
        publisher = _publisher(fake, batch_size=1)
        worker = HorizonLedgerWorker(ws_url="wss://example.invalid/ws", publisher=publisher)
        ack = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"subscription": 4}})
        connect_fn, _calls, _last = fake_connect([ack, ack])
        monkeypatch.setattr("ingestion.horizon_worker._ws_connect", connect_fn)
        await worker._stream_once()
        assert fake.entries == []

    @pytest.mark.asyncio
    async def test_extract_ledger_event_from_streamed_frame(self, monkeypatch):
        # End-to-end: raw transaction record -> structured Redis entry.
        fake = RecordingRedis()
        publisher = _publisher(fake, batch_size=1)
        worker = HorizonLedgerWorker(ws_url="wss://example.invalid/ws", publisher=publisher)
        connect_fn, _calls, _last = fake_connect([_notification()])
        monkeypatch.setattr("ingestion.horizon_worker._ws_connect", connect_fn)

        await worker._stream_once()
        assert len(fake.entries) == 1
        fields = fake.entries[0]
        assert fields["sequence_number"] == "12345"
        payload = json.loads(fields["payload"])
        assert payload["id"]
        assert payload["event_type"] == "transaction"
        assert payload["transaction_hashes"] == ["0xabc"]
        assert payload["operation_logs"][0]["type_name"] == "PAYMENT"
        assert worker.stats()["messages_seen"] == 1


# ---------------------------------------------------------------------------
# Worker — reconnect behaviour
# ---------------------------------------------------------------------------


class TestWorkerReconnect:
    @pytest.mark.asyncio
    async def test_reconnects_after_connection_close(self, monkeypatch):
        publish_frame = json.dumps(
            {
                "jsonrpc": "2.0",
                "method": "subscribe",
                "params": {"subscription": 0, "result": {"type": "ledger", "ledger": 5}},
            }
        )
        ack = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"subscription": 0}})

        def frames(index: int) -> List[str]:
            if index == 1:
                return []  # never used: connection 1 fails on entry
            if index == 2:
                return [ack, publish_frame]  # recovered connection delivers the event
            return [ack]  # later connections: nothing new

        fake = RecordingRedis()
        publisher = _publisher(fake, batch_size=1)
        worker = HorizonLedgerWorker(
            ws_url="wss://example.invalid/ws",
            publisher=publisher,
            reconnect_policy=ReconnectPolicy(base_delay_secs=0, jitter=0, max_delay_secs=0.01),
        )
        # Connection 1 raises ConnectionClosed on entry, subsequent ones work.
        connect_fn, calls, _last = fake_connect(frames, min_index=2)
        monkeypatch.setattr("ingestion.horizon_worker._ws_connect", connect_fn)

        task = asyncio.create_task(worker.start())
        for _ in range(1000):
            if calls["connections"] >= 3:
                break
            await asyncio.sleep(0)
        await worker.stop()
        await asyncio.wait_for(task, timeout=5)
        assert calls["connections"] >= 2
        assert len(fake.entries) == 1
        payload = json.loads(fake.entries[0]["payload"])
        assert payload["sequence_number"] == 5
        assert publisher.stats()["published"] == 1

    @pytest.mark.asyncio
    async def test_backoff_wait_honours_delay(self):
        policy = ReconnectPolicy(base_delay_secs=0.01, backoff_factor=1.0, max_delay_secs=0.01, jitter=0)
        worker = HorizonLedgerWorker(ws_url="x", reconnect_policy=policy)

        await worker._backoff_wait()
        assert worker.stats()["reconnect_attempt"] == 1

    @pytest.mark.asyncio
    async def test_backoff_wait_when_exhausted_sets_stop(self):
        worker = HorizonLedgerWorker(
            ws_url="x",
            reconnect_policy=ReconnectPolicy(max_attempts=1, base_delay_secs=0, jitter=0),
        )
        worker._attempt = 1
        await worker._backoff_wait()
        assert worker._stop_event.is_set()
        assert worker.stats()["state"] == "stopping"

    @pytest.mark.asyncio
    async def test_start_stop_graceful_shutdown(self, monkeypatch):
        record = _notification()

        def frames(index: int) -> List[str]:
            return [record] if index == 1 else []

        connect_fn, _calls, _last = fake_connect(frames)
        monkeypatch.setattr("ingestion.horizon_worker._ws_connect", connect_fn)
        fake = RecordingRedis()
        publisher = _publisher(fake, batch_size=1)
        worker = HorizonLedgerWorker(
            ws_url="wss://example.invalid/ws",
            publisher=publisher,
            reconnect_policy=ReconnectPolicy(base_delay_secs=0, jitter=0),
        )
        task = asyncio.create_task(worker.start())
        for _ in range(1000):
            if fake.entries:
                break
            await asyncio.sleep(0)
        await worker.stop()
        await asyncio.wait_for(task, timeout=5)
        assert worker.stats()["state"] == "stopped"
        assert len(fake.entries) == 1
        payload = json.loads(fake.entries[0]["payload"])
        assert payload["sequence_number"] == 12345


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__]))