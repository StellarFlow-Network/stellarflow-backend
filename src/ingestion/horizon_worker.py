"""horizon_worker.py — High-throughput Horizon ledger event ingestion worker.

A dedicated Python process that streams live ledger events from Horizon / 
Stellar RPC WebSocket endpoints and pushes structured JSON events into Redis
Streams for downstream consumer groups (``src/services/stream_consumer.py``).

Capabilities
------------
* Resilient WebSocket listener with **automatic exponential backoff
  reconnects** (configurable base delay, factor, ceiling and jitter).
* Subscribes to live ``ledgers``, ``transactions`` and Soroban ``events``
  JSON-RPC streams in a single connection.
* Extracts operation logs, contract events and transaction hashes and parses
  raw ``envelope_xdr`` payloads via :mod:`ingestion.horizon_xdr` and
  :mod:`ingestion.horizon_parser`.
* Batches events before ``XADD`` to Redis Streams (``maxlen``-capped) for
  high-throughput writes, with a bounded flush interval for latency tail.
* Graceful SIGINT / SIGTERM shutdown with publisher flush.

Run it directly::

    python -m ingestion.horizon_worker

Environment knobs
-----------------
===============  ============================================  =================
Variable         Description                                  Default
===============  ============================================  =================
``HORIZON_WS_URL``  WebSocket endpoint of the RPC node       ``wss://mainnet.stellar.org/ws``
``REDIS_URL``       Redis connection URL                      ``redis://localhost:6379/0``
``HORIZON_STREAM_KEY`` Redis Stream key                       ``stellarflow:ledger-events``
``HORIZON_STREAM_MAXLEN`` approx-capped stream length         ``100000``
``HORIZON_BATCH_SIZE`` max events per XADD batch              ``100``
``HORIZON_FLUSH_INTERVAL_S`` background flush period          ``2.0``
``HORIZON_RECONNECT_BASE_S`` initial reconnect delay          ``1.0``
``HORIZON_RECONNECT_FACTOR`` backoff multiplier               ``2.0``
``HORIZON_RECONNECT_MAX_S``  backoff ceiling                  ``60.0``
``HORIZON_RECONNECT_JITTER`` random jitter fraction (0..1)    ``0.2``
===============  ============================================  =================
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import signal
import time
from collections import deque
from typing import Any, Deque, Dict, List, Optional

from ingestion.horizon_parser import extract_ledger_event

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Version-safe websockets.connect (importable under websockets 12–15)
# ---------------------------------------------------------------------------
try:  # websockets >= 14
    from websockets.asyncio.client import connect as _ws_connect  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover — websockets 12/13 legacy API
    from websockets import connect as _ws_connect  # type: ignore[no-redef]

# ---------------------------------------------------------------------------
# Configuration defaults (overridable via environment variables)
# ---------------------------------------------------------------------------

DEFAULT_WS_URL: str = os.environ.get("HORIZON_WS_URL", "wss://mainnet.stellar.org/ws")
DEFAULT_REDIS_URL: str = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
DEFAULT_STREAM_KEY: str = os.environ.get("HORIZON_STREAM_KEY", "stellarflow:ledger-events")
DEFAULT_STREAM_MAXLEN: int = int(os.environ.get("HORIZON_STREAM_MAXLEN", "100000"))
DEFAULT_BATCH_SIZE: int = int(os.environ.get("HORIZON_BATCH_SIZE", "100"))
DEFAULT_FLUSH_INTERVAL_S: float = float(os.environ.get("HORIZON_FLUSH_INTERVAL_S", "2.0"))

DEFAULT_RECONNECT_BASE_S: float = float(os.environ.get("HORIZON_RECONNECT_BASE_S", "1.0"))
DEFAULT_RECONNECT_FACTOR: float = float(os.environ.get("HORIZON_RECONNECT_FACTOR", "2.0"))
DEFAULT_RECONNECT_MAX_S: float = float(os.environ.get("HORIZON_RECONNECT_MAX_S", "60.0"))
DEFAULT_RECONNECT_JITTER: float = float(os.environ.get("HORIZON_RECONNECT_JITTER", "0.2"))
DEFAULT_MAX_CONSECUTIVE_ATTEMPTS: int = int(os.environ.get("HORIZON_RECONNECT_MAX_ATTEMPTS", "0"))

#: JSON-RPC subscription payloads issued on every (re)connect.
DEFAULT_SUBSCRIPTIONS: List[Dict[str, Any]] = [
    {"jsonrpc": "2.0", "id": 1, "method": "subscribe", "params": {"type": "ledgers"}},
    {"jsonrpc": "2.0", "id": 2, "method": "subscribe", "params": {"type": "transactions"}},
    {"jsonrpc": "2.0", "id": 3, "method": "subscribe", "params": {"type": "events"}},
]

__all__ = [
    "DEFAULT_SUBSCRIPTIONS",
    "ReconnectPolicy",
    "RedisStreamPublisher",
    "HorizonLedgerWorker",
    "main",
]


# ---------------------------------------------------------------------------
# Exponential backoff reconnect policy
# ---------------------------------------------------------------------------


class ReconnectPolicy:
    """Exponential backoff delay schedule for WebSocket reconnect attempts.

    Parameters
    ----------
    base_delay_secs:
        Delay before the first reconnect attempt.
    backoff_factor:
        Multiplier applied per attempt: ``delay = base * factor ** (attempt - 1)``.
    max_delay_secs:
        Hard ceiling on the computed delay.
    jitter:
        Randomisation fraction in ``[0, 1)``.  The final delay is drawn
        uniformly from ``[delay * (1 - jitter), delay]`` to de-synchronise
        multiple workers reconnecting at once.
    max_attempts:
        Maximum consecutive attempts before the worker gives up.  ``0``
        (the default) means retry forever.
    """

    def __init__(
        self,
        *,
        base_delay_secs: float = DEFAULT_RECONNECT_BASE_S,
        backoff_factor: float = DEFAULT_RECONNECT_FACTOR,
        max_delay_secs: float = DEFAULT_RECONNECT_MAX_S,
        jitter: float = DEFAULT_RECONNECT_JITTER,
        max_attempts: int = DEFAULT_MAX_CONSECUTIVE_ATTEMPTS,
    ) -> None:
        if base_delay_secs < 0:
            raise ValueError("base_delay_secs must be non-negative")
        if backoff_factor < 1.0:
            raise ValueError("backoff_factor must be >= 1.0")
        if max_delay_secs < base_delay_secs:
            raise ValueError("max_delay_secs must be >= base_delay_secs")
        if not 0 <= jitter < 1:
            raise ValueError("jitter must be in the range [0, 1)")
        self.base_delay_secs = base_delay_secs
        self.backoff_factor = backoff_factor
        self.max_delay_secs = max_delay_secs
        self.jitter = jitter
        self.max_attempts = max_attempts

    def delay_for(self, attempt: int) -> float:
        """Return the (pre-jitter) backoff delay in seconds for *attempt*.

        *attempt* is 1-indexed: the first reconnect uses ``base_delay_secs``.
        """
        if attempt < 1:
            raise ValueError("attempt must be >= 1")
        delay = self.base_delay_secs * (self.backoff_factor ** (attempt - 1))
        return min(delay, self.max_delay_secs)

    def delay(self, attempt: int) -> float:
        """Return the jittered delay in seconds for *attempt* (never negative)."""
        base = self.delay_for(attempt)
        if self.jitter <= 0:
            return base
        return base * (1.0 - self.jitter * random.random())

    def exhausted(self, attempt: int) -> bool:
        """Return ``True`` if no further reconnect attempts should be made."""
        return self.max_attempts > 0 and attempt >= self.max_attempts


# ---------------------------------------------------------------------------
# Redis Stream publisher
# ---------------------------------------------------------------------------


class RedisStreamPublisher:
    """Batcher + writer that pushes structured ledger events into a Redis Stream.

    Events are buffered in an in-memory deque and flushed to Redis in bulk
    via ``XADD`` once the batch size is reached or the flush interval elapses.
    The stream is approximate-``MAXLEN``-capped so the hot stream can never
    grow unbounded.
    """

    def __init__(
        self,
        *,
        redis_url: str = DEFAULT_REDIS_URL,
        stream_key: str = DEFAULT_STREAM_KEY,
        maxlen: int = DEFAULT_STREAM_MAXLEN,
        batch_size: int = DEFAULT_BATCH_SIZE,
        flush_interval_secs: float = DEFAULT_FLUSH_INTERVAL_S,
        redis_client: Any = None,
    ) -> None:
        if batch_size < 1:
            raise ValueError("batch_size must be >= 1")
        if maxlen < 1:
            raise ValueError("maxlen must be >= 1")
        if flush_interval_secs < 0:
            raise ValueError("flush_interval_secs must be non-negative")
        self.redis_url = redis_url
        self.stream_key = stream_key
        self.maxlen = maxlen
        self.batch_size = batch_size
        self.flush_interval_secs = flush_interval_secs
        self._redis: Any = redis_client  # injectable for tests
        self._pending: Deque[Dict[str, Any]] = deque()
        self._lock = asyncio.Lock()
        self._closed = False
        self._last_flush = 0.0
        self._stats = {
            "published": 0,
            "batches": 0,
            "errors": 0,
            "pending": 0,
            "connected": False,
        }

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """Open the lazy Redis connection (no-op if one was injected)."""
        if self._redis is not None:
            self._stats["connected"] = True
            return
        if self._closed:
            raise RuntimeError("publisher is closed")
        try:
            import redis.asyncio as aioredis  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "redis[asyncio] is required for RedisStreamPublisher. "
                "Install it with: pip install redis[asyncio]"
            ) from exc
        self._redis = await aioredis.from_url(self.redis_url, decode_responses=True)
        self._stats["connected"] = True
        logger.info("[HorizonWorker] Connected to Redis at %s", self.redis_url)

    async def close(self) -> None:
        """Flush pending events and close the Redis connection."""
        self._closed = True
        try:
            await self.flush()
        finally:
            self._stats["connected"] = False
            if self._redis is not None:
                if hasattr(self._redis, "aclose"):
                    await self._redis.aclose()
                elif hasattr(self._redis, "close"):
                    await self._redis.close()
                self._redis = None

    # ------------------------------------------------------------------
    # Publishing
    # ------------------------------------------------------------------

    async def publish(self, event: Dict[str, Any]) -> None:
        """Queue *event* for the next stream flush.  Safe to call concurrently.

        The buffer is flushed when it reaches the batch size *or* when the
        flush interval has elapsed since the previous flush (keeps latency
        bounded for sparse streams without a dedicated background task).
        """
        async with self._lock:
            if self._closed:
                raise RuntimeError("publisher is closed")
            self._pending.append(event)
            reached_batch = len(self._pending) >= self.batch_size

        if reached_batch:
            await self.flush()
        elif self.flush_interval_secs > 0:
            now = time.monotonic()
            if now - self._last_flush >= self.flush_interval_secs:
                self._last_flush = now
                await self.flush()

    async def flush(self) -> int:
        """Deliver all buffered events to the Redis Stream in a single XADD batch.

        Returns the number of events published.
        """
        async with self._lock:
            if not self._pending:
                return 0
            batch = list(self._pending)
            self._pending.clear()
        self._stats["pending"] = len(self._pending)

        if self._redis is None:
            await self.connect()

        # redis-py only supports one {field: value} map per XADD; publish each
        # event as its own entry so the consumer group can ack independently.
        published = 0
        for event in batch:
            fields = {
                "type": "horizon ledger event",
                "source": "horizon-rpc-stream",
                "sequence_number": str(event.get("sequence_number", "")),
                "payload": json.dumps(event, separators=(",", ":"), ensure_ascii=False),
            }
            try:
                await self._redis.xadd(
                    self.stream_key,
                    fields,
                    maxlen=self.maxlen,
                    approximate=True,
                )
                published += 1
            except Exception as exc:  # noqa: BLE001
                self._stats["errors"] += 1
                logger.error(
                    "[HorizonWorker] XADD to %s failed: %s",
                    self.stream_key,
                    exc,
                )

        self._stats["published"] += published
        self._stats["batches"] += 1
        if published:
            logger.debug(
                "[HorizonWorker] Flushed %d event(s) to stream '%s'",
                published,
                self.stream_key,
            )
        return published

    def stats(self) -> Dict[str, Any]:
        """Return a snapshot of publisher counters (pending included)."""
        snapshot = dict(self._stats)
        snapshot["pending"] = len(self._pending)
        return snapshot


# ---------------------------------------------------------------------------
# WebSocket listener worker
# ---------------------------------------------------------------------------


class HorizonLedgerWorker:
    """Resilient Horizon WebSocket listener that publishes to Redis Streams.

    Parameters
    ----------
    ws_url:
        WebSocket endpoint of the Horizon / Stellar RPC node.
    subscriptions:
        JSON-RPC payloads sent immediately after each (re)connect.
    publisher:
        A :class:`RedisStreamPublisher` (or compatible).  Created from
        ``redis_url``/``stream_key`` when omitted.
    redis_url:
        Redis connection URL used when *publisher* is not supplied.
    stream_key:
        Redis Stream key used when *publisher* is not supplied.
    reconnect_policy:
        Backoff schedule; a :class:`ReconnectPolicy` is created when omitted.
    """

    def __init__(
        self,
        *,
        ws_url: Optional[str] = None,
        subscriptions: Optional[List[Dict[str, Any]]] = None,
        publisher: Optional[RedisStreamPublisher] = None,
        redis_url: str = DEFAULT_REDIS_URL,
        stream_key: str = DEFAULT_STREAM_KEY,
        reconnect_policy: Optional[ReconnectPolicy] = None,
    ) -> None:
        self.ws_url = ws_url or DEFAULT_WS_URL
        self.subscriptions = subscriptions if subscriptions is not None else list(DEFAULT_SUBSCRIPTIONS)
        self.publisher = publisher or RedisStreamPublisher(redis_url=redis_url, stream_key=stream_key)
        self.reconnect_policy = reconnect_policy or ReconnectPolicy()
        self._stop_event = asyncio.Event()
        self._attempt = 0
        self._state = "stopped"
        self._messages_seen = 0

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Begin the connect → stream → reconnect loop (blocks until stopped)."""
        self._state = "running"
        await self.publisher.connect()
        logger.info(
            "[HorizonWorker] Starting ledger stream from %s → %s",
            self.ws_url,
            self.publisher.stream_key,
        )
        try:
            while not self._stop_event.is_set():
                await self._stream_once()
                if self._stop_event.is_set():
                    break
                await self._backoff_wait()
        finally:
            await self.publisher.close()
            self._state = "stopped"

    async def stop(self) -> None:
        """Request a graceful shutdown (flushes the publisher buffer)."""
        self._stop_event.set()
        self._state = "stopping"

    def is_running(self) -> bool:
        return self._state in ("running", "stopping")

    def stats(self) -> Dict[str, int]:
        return {
            "state": self._state,
            "reconnect_attempt": self._attempt,
            "messages_seen": self._messages_seen,
            "publisher": self.publisher.stats(),
        }

    # ------------------------------------------------------------------
    # Reconnect
    # ------------------------------------------------------------------

    async def _backoff_wait(self) -> None:
        """Sleep according to the exponential backoff schedule (or exit)."""
        if self.reconnect_policy.exhausted(self._attempt):
            logger.error(
                "[HorizonWorker] Giving up after %d reconnect attempt(s).",
                self._attempt,
            )
            self._stop_event.set()
            self._state = "stopping"
            return
        self._attempt += 1
        delay = self.reconnect_policy.delay(self._attempt)
        logger.warning(
            "[HorizonWorker] Reconnect attempt %d in %.2fs…",
            self._attempt,
            delay,
        )
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=delay)
        except asyncio.TimeoutError:
            return

    # ------------------------------------------------------------------
    # Streaming
    # ------------------------------------------------------------------

    async def _stream_once(self) -> None:
        """Open a single WebSocket session, subscribe, and consume frames."""
        try:
            self._state = "connecting"
            async with _ws_connect(self.ws_url) as ws:
                self._state = "streaming"
                # A successful (re)connect resets the backoff counter.
                self._attempt = 0
                logger.info("[HorizonWorker] Connected to %s", self.ws_url)
                for subscription in self.subscriptions:
                    await ws.send(json.dumps(subscription))
                async for raw in ws:
                    await self._handle_message(raw)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — ConnectionClosed, OSError, timeouts…
            logger.warning("[HorizonWorker] Stream interrupted: %s", exc)

    async def _handle_message(self, raw: Any) -> None:
        """Normalise a WebSocket frame and enqueue the resulting event."""
        self._messages_seen += 1
        try:
            event = extract_ledger_event(raw)
        except Exception as exc:  # noqa: BLE001
            logger.error("[HorizonWorker] Failed to parse frame: %s", exc)
            return
        if event is None:
            return
        await self.publisher.publish(event)


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------


def _signal_handlers(worker: HorizonLedgerWorker, loop: asyncio.AbstractEventLoop):
    def _handle(sig: signal.Signals) -> None:
        logger.info("[HorizonWorker] Received %s — shutting down gracefully…", sig.name)
        loop.create_task(worker.stop())

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle, sig)
        except NotImplementedError:  # pragma: no cover — non-UNIX event loop
            signal.signal(sig, lambda s, _: loop.create_task(worker.stop()))


def main() -> int:
    """Entry point for ``python -m ingestion.horizon_worker``."""
    logging.basicConfig(
        level=os.environ.get("HORIZON_LOG_LEVEL", "INFO"),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    policy = ReconnectPolicy()
    publisher = RedisStreamPublisher()
    worker = HorizonLedgerWorker(publisher=publisher, reconnect_policy=policy)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _signal_handlers(worker, loop)
    try:
        loop.run_until_complete(worker.start())
    except KeyboardInterrupt:  # pragma: no cover
        pass
    finally:
        pending = asyncio.all_tasks(loop)
        for task in pending:
            task.cancel()
        loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        loop.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())