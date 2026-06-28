"""queue/backpressure.py — Backpressure utilities for Soroban RPC ingestion pipelines.

Two complementary primitives are provided:

1. **Token-bucket rate limiter** (``TokenBucket`` / ``TokenBucketController``) —
   controls the *rate* at which callers may consume capacity.

2. **Drop-tail ingestion queue** (``BoundedIngestionQueue`` /
   ``BackpressureQueueManager``) — a capacity-bounded, priority-aware FIFO that
   automatically sheds non-essential *historical tracing metric* packets once the
   buffer reaches 90 % capacity, keeping the primary live price channels clear.

Drop-tail threshold policy
--------------------------
The ``BackpressureQueueManager`` enforces a two-stage policy:

* **Slow-down stage** (default ≥ 70 % full): a proportional back-off delay is
  injected on the producer side so upstream callers naturally pace themselves.
* **Drop-tail stage** (default ≥ 90 % full): any incoming packet whose priority
  is ``PacketPriority.METRIC`` (historical tracing data) is immediately discarded
  *before* it touches the queue.  ``STANDARD`` and ``CRITICAL`` live-price
  packets continue to be accepted.  This prevents a burst of low-value telemetry
  from evicting the financial data that downstream consumers actually need.

Packet priorities
-----------------
``CRITICAL``  — live price data that must not be lost; blocks until space frees.
``STANDARD``  — ordinary live price / rate-fetch events; dropped only when full.
``METRIC``    — historical tracing metrics; first to be shed under pressure.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Dict, Optional
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Packet model
# ---------------------------------------------------------------------------


class PacketPriority(IntEnum):
    """Priority levels for ingestion packets.

    Lower integer == higher urgency.  The drop-tail policy sheds ``METRIC``
    packets first (highest integer) when the buffer queue nears capacity.
    """

    CRITICAL = 0  # Live price data — blocks until accepted, never auto-dropped
    STANDARD = 1  # Ordinary live price / rate-fetch events
    METRIC = 2    # Historical tracing metrics — dropped early under pressure


@dataclass
class IngestionPacket:
    """A single unit of work queued for downstream ingestion.

    Attributes
    ----------
    priority:
        Controls how the queue manager handles the packet under backpressure.
    data:
        Arbitrary payload (price record, telemetry frame, etc.).
    timestamp:
        Unix epoch milliseconds when the packet was created.
    """

    priority: PacketPriority
    data: Any
    timestamp: float = field(default_factory=lambda: time.monotonic() * 1_000)


# ---------------------------------------------------------------------------
# Bounded ingestion queue
# ---------------------------------------------------------------------------


class BoundedIngestionQueue:
    """Thread-safe, capacity-bounded FIFO queue for ingestion packets.

    Implemented directly on top of ``collections.deque`` and
    ``threading.Condition`` to avoid a naming conflict with the stdlib
    ``queue`` module (the enclosing package directory shares the name
    ``queue``, which would shadow the stdlib import).

    The public interface mirrors the TypeScript ``AsyncBoundedQueue`` in
    ``backpressure.ts`` so both sides of the system express the same contract.
    """

    def __init__(self, max_size: int) -> None:
        if max_size < 1:
            raise ValueError("max_size must be >= 1")
        self._max_size = max_size
        from collections import deque
        self._dq: deque = deque()
        self._cond = threading.Condition(threading.Lock())
        self._unfinished_tasks = 0

    # ------------------------------------------------------------------
    # Producer side
    # ------------------------------------------------------------------

    def put_nowait(self, packet: IngestionPacket) -> bool:
        """Try to enqueue *packet* without blocking.

        Returns ``True`` if the packet was accepted, ``False`` if the queue is
        already at capacity.
        """
        with self._cond:
            if len(self._dq) >= self._max_size:
                return False
            self._dq.append(packet)
            self._unfinished_tasks += 1
            self._cond.notify()
            return True

    def put_blocking(
        self, packet: IngestionPacket, timeout: Optional[float] = None
    ) -> bool:
        """Enqueue *packet*, blocking until space is available.

        Parameters
        ----------
        packet:
            The packet to enqueue.
        timeout:
            Maximum seconds to wait.  ``None`` waits indefinitely.  Returns
            ``False`` if the timeout expires before space becomes available.
        """
        deadline = time.monotonic() + timeout if timeout is not None else None
        with self._cond:
            while len(self._dq) >= self._max_size:
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return False
                    self._cond.wait(timeout=remaining)
                else:
                    self._cond.wait()
            self._dq.append(packet)
            self._unfinished_tasks += 1
            self._cond.notify()
            return True

    # ------------------------------------------------------------------
    # Consumer side
    # ------------------------------------------------------------------

    def get_nowait(self) -> Optional[IngestionPacket]:
        """Dequeue the next packet without blocking.  Returns ``None`` if empty."""
        with self._cond:
            if not self._dq:
                return None
            item = self._dq.popleft()
            self._cond.notify_all()
            return item

    def get_blocking(
        self, timeout: Optional[float] = None
    ) -> Optional[IngestionPacket]:
        """Dequeue the next packet, blocking until one is available.

        Returns ``None`` if *timeout* expires before an item arrives.
        """
        deadline = time.monotonic() + timeout if timeout is not None else None
        with self._cond:
            while not self._dq:
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return None
                    self._cond.wait(timeout=remaining)
                else:
                    self._cond.wait()
            item = self._dq.popleft()
            self._cond.notify_all()
            return item

    def task_done(self) -> None:
        """Signal that a previously dequeued packet has been fully processed."""
        with self._cond:
            if self._unfinished_tasks <= 0:
                raise ValueError("task_done() called too many times")
            self._unfinished_tasks -= 1
            self._cond.notify_all()

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def size(self) -> int:
        """Current number of packets in the queue."""
        with self._cond:
            return len(self._dq)

    def is_empty(self) -> bool:
        with self._cond:
            return len(self._dq) == 0

    def is_full(self) -> bool:
        with self._cond:
            return len(self._dq) >= self._max_size

    @property
    def max_size(self) -> int:
        return self._max_size


# ---------------------------------------------------------------------------
# Metrics / configuration
# ---------------------------------------------------------------------------


@dataclass
class BackpressureConfig:
    """Tunable parameters for :class:`BackpressureQueueManager`."""

    max_capacity: int = 1_000
    """Hard upper bound on the number of queued packets."""

    drop_threshold: float = 0.90
    """Saturation level (0–1) at which METRIC packets are dropped immediately."""

    slow_down_threshold: float = 0.70
    """Saturation level (0–1) at which producers experience a back-off delay."""

    slow_down_delay_ms: float = 100.0
    """Maximum back-off delay (milliseconds) injected at 100 % saturation.

    The actual delay is proportional to how far above ``slow_down_threshold``
    the queue currently sits::

        delay = slow_down_delay_ms * (sat - slow_down_threshold)
                                   / (1 - slow_down_threshold)
    """

    enable_metrics: bool = True
    """Whether to maintain internal drop / slow-down counters."""


@dataclass
class BackpressureSnapshot:
    """Immutable view of queue health at a point in time."""

    queue_length: int
    max_capacity: int
    saturation: float
    dropped_packets: int
    slowed_down_ingestions: int
    average_processing_time_ms: float


# ---------------------------------------------------------------------------
# Mutable internal counters (always accessed under _metrics_lock)
# ---------------------------------------------------------------------------


@dataclass
class _Metrics:
    dropped_packets: int = 0
    slowed_down_ingestions: int = 0
    processing_times_ms: list = field(default_factory=list)

    _MAX_SAMPLES: int = field(default=100, init=False, repr=False, compare=False)

    def record_processing_time(self, ms: float) -> None:
        self.processing_times_ms.append(ms)
        if len(self.processing_times_ms) > self._MAX_SAMPLES:
            self.processing_times_ms.pop(0)

    @property
    def average_processing_time_ms(self) -> float:
        if not self.processing_times_ms:
            return 0.0
        return sum(self.processing_times_ms) / len(self.processing_times_ms)


# ---------------------------------------------------------------------------
# BackpressureQueueManager — the main public API for Python services
# ---------------------------------------------------------------------------


class BackpressureQueueManager:
    """Queue ingestion pipeline with a structured drop-tail threshold policy.

    Designed for Soroban RPC network-facing services where sudden latency spikes
    cause the internal buffer to swell.  The manager applies the following rules
    in order:

    1. **Slow-down** — when saturation ≥ ``drop_threshold - 0.2`` (default 70%)
       the *calling thread* sleeps for a proportional delay so upstream producers
       naturally pace themselves.
    2. **Drop-tail** — when saturation ≥ ``drop_threshold`` (default 90%) any
       ``PacketPriority.METRIC`` packet (historical tracing data) is discarded
       immediately.  This is the *structured drop-tail threshold policy*: the
       buffer is protected by shedding the lowest-value traffic class early,
       before live price channel packets are at risk.
    3. **Overflow handling** — if the queue is completely full, ``CRITICAL``
       packets block until space is available; all others are dropped.

    Thread safety
    -------------
    All public methods are safe to call from multiple threads simultaneously.
    The underlying :class:`BoundedIngestionQueue` inherits the thread-safety
    guarantees of :class:`queue.Queue`.

    Usage::

        manager = BackpressureQueueManager(BackpressureConfig(max_capacity=500))

        # Producer (e.g., Soroban RPC poll loop)
        accepted = manager.enqueue(IngestionPacket(
            priority=PacketPriority.STANDARD,
            data=price_record,
        ))

        # Consumer (e.g., DB sink worker)
        packet = manager.dequeue(timeout=1.0)
        if packet:
            process(packet.data)
            manager.task_done()
    """

    def __init__(self, config: Optional[BackpressureConfig] = None) -> None:
        self._config = config or BackpressureConfig()
        self._queue = BoundedIngestionQueue(self._config.max_capacity)
        self._metrics = _Metrics()
        self._metrics_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Producer API
    # ------------------------------------------------------------------

    def enqueue(self, packet: IngestionPacket) -> bool:
        """Submit *packet* to the ingestion pipeline.

        The drop-tail threshold policy is enforced here before the packet
        reaches the queue:

        * At ≥ ``slow_down_threshold`` saturation: inject a proportional
          back-off delay on the calling thread.
        * At ≥ ``drop_threshold`` saturation: immediately discard
          ``METRIC`` packets and return ``False``.

        Returns ``True`` if the packet was accepted, ``False`` if it was
        dropped (backpressure activated).
        """
        saturation = self._saturation()

        # ── Stage 1: slow-down ────────────────────────────────────────
        if saturation >= self._config.slow_down_threshold:
            self._apply_slow_down(saturation)

        # ── Stage 2: drop-tail for METRIC packets ─────────────────────
        if saturation >= self._config.drop_threshold:
            if packet.priority == PacketPriority.METRIC:
                logger.warning(
                    "[Backpressure] Drop-tail active — saturation %.0f%%. "
                    "Dropping METRIC packet (historical tracing data).",
                    saturation * 100,
                )
                if self._config.enable_metrics:
                    with self._metrics_lock:
                        self._metrics.dropped_packets += 1
                return False

        # ── Stage 3: try non-blocking enqueue ─────────────────────────
        if self._queue.put_nowait(packet):
            return True

        # ── Stage 4: queue is full — priority-based overflow handling ──
        if packet.priority == PacketPriority.CRITICAL:
            # Block until space is available — live price data must not be lost.
            logger.warning(
                "[Backpressure] Queue full. CRITICAL packet blocking until "
                "space is available."
            )
            accepted = self._queue.put_blocking(packet, timeout=None)
            if not accepted:
                logger.error(
                    "[Backpressure] Failed to enqueue CRITICAL packet (queue closed?)."
                )
                if self._config.enable_metrics:
                    with self._metrics_lock:
                        self._metrics.dropped_packets += 1
            return accepted
        else:
            # Non-critical — drop rather than block.
            logger.error(
                "[Backpressure] Queue overflow. Dropping %s packet.",
                packet.priority.name,
            )
            if self._config.enable_metrics:
                with self._metrics_lock:
                    self._metrics.dropped_packets += 1
            return False

    # ------------------------------------------------------------------
    # Consumer API
    # ------------------------------------------------------------------

    def dequeue(self, timeout: Optional[float] = 1.0) -> Optional[IngestionPacket]:
        """Remove and return the next packet from the queue.

        Parameters
        ----------
        timeout:
            Seconds to wait for an item.  ``None`` waits indefinitely.
            Returns ``None`` if the timeout expires.
        """
        start = time.monotonic()
        packet = self._queue.get_blocking(timeout=timeout)
        if packet is not None and self._config.enable_metrics:
            elapsed_ms = (time.monotonic() - start) * 1_000
            with self._metrics_lock:
                self._metrics.record_processing_time(elapsed_ms)
        return packet

    def try_dequeue(self) -> Optional[IngestionPacket]:
        """Non-blocking dequeue.  Returns ``None`` immediately if queue is empty."""
        start = time.monotonic()
        packet = self._queue.get_nowait()
        if packet is not None and self._config.enable_metrics:
            elapsed_ms = (time.monotonic() - start) * 1_000
            with self._metrics_lock:
                self._metrics.record_processing_time(elapsed_ms)
        return packet

    def task_done(self) -> None:
        """Signal that the last dequeued packet has been fully processed.

        Must be called once per :meth:`dequeue` / :meth:`try_dequeue` call to
        allow :meth:`queue.Queue.join` to unblock.
        """
        self._queue.task_done()

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def get_queue_length(self) -> int:
        """Current number of packets waiting in the queue."""
        return self._queue.size()

    def get_max_capacity(self) -> int:
        return self._config.max_capacity

    def snapshot(self) -> BackpressureSnapshot:
        """Return an immutable snapshot of current queue health metrics."""
        with self._metrics_lock:
            avg_ms = self._metrics.average_processing_time_ms
            dropped = self._metrics.dropped_packets
            slowed = self._metrics.slowed_down_ingestions
        length = self._queue.size()
        return BackpressureSnapshot(
            queue_length=length,
            max_capacity=self._config.max_capacity,
            saturation=round(length / self._config.max_capacity, 4),
            dropped_packets=dropped,
            slowed_down_ingestions=slowed,
            average_processing_time_ms=round(avg_ms, 4),
        )

    def reset_metrics(self) -> None:
        """Reset counters and timing samples (useful for testing)."""
        with self._metrics_lock:
            self._metrics.dropped_packets = 0
            self._metrics.slowed_down_ingestions = 0
            self._metrics.processing_times_ms.clear()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _saturation(self) -> float:
        """Current queue fill ratio as a value in [0.0, 1.0]."""
        return self._queue.size() / self._config.max_capacity

    def _apply_slow_down(self, saturation: float) -> None:
        """Inject a proportional back-off delay on the calling thread.

        The delay grows linearly from 0 ms at ``slow_down_threshold`` to
        ``slow_down_delay_ms`` at 100 % saturation.
        """
        headroom = 1.0 - self._config.slow_down_threshold
        if headroom <= 0:
            return
        ratio = (saturation - self._config.slow_down_threshold) / headroom
        delay_s = max(0.0, (self._config.slow_down_delay_ms * ratio) / 1_000)
        if delay_s > 0:
            if self._config.enable_metrics:
                with self._metrics_lock:
                    self._metrics.slowed_down_ingestions += 1
            logger.debug(
                "[Backpressure] Slowing down ingestion by %.1f ms "
                "(saturation: %.0f%%).",
                delay_s * 1_000,
                saturation * 100,
            )
            time.sleep(delay_s)


# ---------------------------------------------------------------------------
# Module-level singleton (mirrors token_bucket_controller pattern)
# ---------------------------------------------------------------------------

#: Shared queue manager; configure via ``backpressure_queue_manager._config``
#: or replace with a custom instance before starting workers.
backpressure_queue_manager = BackpressureQueueManager()


# ===========================================================================
# Token-bucket rate limiter (unchanged — kept for backward-compat)
# ===========================================================================



@dataclass(frozen=True)
class TokenBucketConfig:
    max_tokens: float
    refill_rate: float
    refill_interval: float = 1.0


@dataclass(frozen=True)
class TokenBucketSnapshot:
    current_tokens: float
    max_tokens: float
    fill_ratio: float
    is_throttled: bool


class TokenBucket:
    __slots__ = ("_config", "_tokens", "_last_refill", "_lock")

    def __init__(self, config: TokenBucketConfig) -> None:
        self._config = config
        self._tokens: float = config.max_tokens
        self._last_refill: float = time.monotonic()
        self._lock = threading.Lock()

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        if elapsed >= self._config.refill_interval:
            tokens_to_add = elapsed * self._config.refill_rate
            if tokens_to_add > 0:
                self._tokens = min(
                    self._config.max_tokens, self._tokens + tokens_to_add
                )
            self._last_refill = now

    def try_consume(self, tokens: float = 1.0) -> bool:
        with self._lock:
            self._refill()
            if self._tokens >= tokens:
                self._tokens -= tokens
                return True
            return False

    def consume_or_wait(
        self, tokens: float = 1.0, timeout: Optional[float] = None
    ) -> bool:
        deadline = time.monotonic() + timeout if timeout is not None else None
        while True:
            if self.try_consume(tokens):
                return True
            if deadline is not None and time.monotonic() >= deadline:
                return False
            time.sleep(max(0.001, self._config.refill_interval / 100))

    @property
    def available_tokens(self) -> float:
        with self._lock:
            self._refill()
            return self._tokens

    def snapshot(self) -> TokenBucketSnapshot:
        with self._lock:
            self._refill()
            return TokenBucketSnapshot(
                current_tokens=round(self._tokens, 4),
                max_tokens=self._config.max_tokens,
                fill_ratio=round(self._tokens / self._config.max_tokens, 4),
                is_throttled=self._tokens < 1.0,
            )

    def reset(self) -> None:
        with self._lock:
            self._tokens = self._config.max_tokens
            self._last_refill = time.monotonic()

    def update_config(self, config: TokenBucketConfig) -> None:
        with self._lock:
            self._config = config
            if self._tokens > config.max_tokens:
                self._tokens = config.max_tokens


class TokenBucketController:
    __slots__ = ("_buckets", "_map_lock", "_default_config")

    def __init__(
        self, default_config: Optional[TokenBucketConfig] = None
    ) -> None:
        self._default_config = default_config or TokenBucketConfig(
            max_tokens=100,
            refill_rate=10.0,
            refill_interval=1.0,
        )
        self._buckets: Dict[str, TokenBucket] = {}
        self._map_lock = threading.Lock()

    def _get_or_create(self, key: str) -> TokenBucket:
        bucket = self._buckets.get(key)
        if bucket is None:
            with self._map_lock:
                bucket = self._buckets.get(key)
                if bucket is None:
                    bucket = TokenBucket(self._default_config)
                    self._buckets[key] = bucket
        return bucket

    def try_consume(self, key: str, tokens: float = 1.0) -> bool:
        return self._get_or_create(key).try_consume(tokens)

    def consume_or_wait(
        self, key: str, tokens: float = 1.0, timeout: Optional[float] = None
    ) -> bool:
        return self._get_or_create(key).consume_or_wait(tokens, timeout)

    def snapshot(self, key: str) -> TokenBucketSnapshot:
        return self._get_or_create(key).snapshot()

    def configure(
        self, key: str, config: TokenBucketConfig
    ) -> None:
        self._get_or_create(key).update_config(config)

    def reset(self, key: Optional[str] = None) -> None:
        if key is not None:
            self._get_or_create(key).reset()
        else:
            with self._map_lock:
                for bucket in self._buckets.values():
                    bucket.reset()

    def snapshot_all(self) -> Dict[str, TokenBucketSnapshot]:
        return {k: v.snapshot() for k, v in self._buckets.items()}


token_bucket_controller = TokenBucketController()

__all__ = [
    # Drop-tail ingestion queue pipeline
    "PacketPriority",
    "IngestionPacket",
    "BackpressureConfig",
    "BackpressureSnapshot",
    "BoundedIngestionQueue",
    "BackpressureQueueManager",
    "backpressure_queue_manager",
    # Token-bucket rate limiter (backward-compat)
    "TokenBucketConfig",
    "TokenBucketSnapshot",
    "TokenBucket",
    "TokenBucketController",
    "token_bucket_controller",
]
