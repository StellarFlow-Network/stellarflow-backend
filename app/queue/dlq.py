"""
app/queue/dlq.py — Dead-Letter Queue with Exponential Backoff Retries
Issue #717

Diverts unparseable or failed ledger event payloads to a Redis Dead-Letter
Queue (DLQ) to avoid blocking the primary ingestion pipeline.

Features:
* Push unhandled ingestion exception payloads into a Redis DLQ channel.
* Exponential backoff retry policy (3 attempts max, configurable).
* REST handler compatible with the Express / FastAPI admin layer:
  GET  /api/v1/admin/dlq         — inspect queued payloads
  POST /api/v1/admin/dlq/replay  — replay one or all payloads

Designed to integrate with the existing ``src/queue/pipeline.py``
back-pressure pipeline and ``src/api/admin_audit.py`` audit trail.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
import time
import traceback
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Awaitable

logger = logging.getLogger(__name__)
# ---------------------------------------------------------------------------
# OpenTelemetry — W3C trace-context propagation across the DLQ (Issue #760)
# ---------------------------------------------------------------------------
#
# The DLQ is itself an async queue: a payload can fail during the original
# request/task, sit in Redis for minutes or days, and only run again when an
# operator calls the replay endpoint from an unrelated later request. Without
# help, that later replay would start a brand-new, disconnected trace. To
# keep it linked to the original failure, ``DLQEntry`` stores the W3C
# ``traceparent``/``tracestate`` headers captured at push time, and replay
# restores them as the parent context for the retry span.
#
# OpenTelemetry is an optional runtime dependency from this module's point of
# view (it's imported lazily so app/queue/dlq.py keeps working even in a
# context where the otel packages aren't installed), matching the defensive
# try/except ImportError style used elsewhere in this codebase.
try:
    from opentelemetry import propagate as _otel_propagation
    from opentelemetry import trace as _otel_trace

    _OTEL_AVAILABLE = True
    _tracer = _otel_trace.get_tracer(__name__)
except ImportError:  # pragma: no cover - exercised when otel isn't installed
    _OTEL_AVAILABLE = False
    _tracer = None


def _capture_trace_context() -> Optional[Dict[str, str]]:
    """Serialise the currently active span context as a W3C carrier dict so
    it can travel inside a Redis-stored :class:`DLQEntry` and be restored by
    whichever process eventually replays it."""
    if not _OTEL_AVAILABLE:
        return None
    carrier: Dict[str, str] = {}
    _otel_propagation.inject(carrier)
    return carrier or None


def _extract_trace_context(carrier: Optional[Dict[str, str]]):
    """Rebuild an OpenTelemetry context from a stored W3C carrier dict."""
    if not _OTEL_AVAILABLE or not carrier:
        return None
    return _otel_propagation.extract(carrier)


@contextlib.asynccontextmanager
async def _dlq_span(name: str, parent_ctx: Any, attributes: Dict[str, Any]):
    """Start a span under *parent_ctx* (or the current context if ``None``)
    for the duration of the wrapped block. A no-op context manager when
    OpenTelemetry isn't installed."""
    if not _OTEL_AVAILABLE or _tracer is None:
        yield
        return
    with _tracer.start_as_current_span(name, context=parent_ctx, attributes=attributes):
        yield

__all__ = [
    # Data structures
    "DLQEntry",
    "DLQStats",
    "RetryPolicy",
    # Core DLQ
    "RedisDLQ",
    # Factory / singleton helpers
    "configure_dlq",
    "get_dlq",
    # Decorator
    "with_dlq_fallback",
]

# ---------------------------------------------------------------------------
# Configuration knobs (override via environment variables)
# ---------------------------------------------------------------------------

#: Redis channel / list key for DLQ payloads.
_DLQ_REDIS_KEY: str = os.environ.get("DLQ_REDIS_KEY", "stellarflow:dlq")

#: Maximum number of entries retained in the DLQ list (FIFO eviction).
_DLQ_MAX_SIZE: int = int(os.environ.get("DLQ_MAX_SIZE", "10000"))

#: Default maximum retry attempts before a payload is permanently failed.
_DLQ_MAX_RETRIES: int = int(os.environ.get("DLQ_MAX_RETRIES", "3"))

#: Base delay (seconds) for exponential backoff on retry attempt 1.
_DLQ_BASE_DELAY_SECS: float = float(os.environ.get("DLQ_BASE_DELAY_SECS", "2.0"))

#: Multiplier applied on each successive retry.
_DLQ_BACKOFF_FACTOR: float = float(os.environ.get("DLQ_BACKOFF_FACTOR", "2.0"))

#: Maximum backoff ceiling (seconds) regardless of attempt number.
_DLQ_MAX_DELAY_SECS: float = float(os.environ.get("DLQ_MAX_DELAY_SECS", "60.0"))


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class RetryPolicy:
    """Configurable exponential backoff policy.

    Attributes
    ----------
    max_attempts:
        Total number of processing attempts (including the initial one).
    base_delay_secs:
        Wait time in seconds before the first retry.
    backoff_factor:
        Multiplier applied on each retry: delay = base * factor^(attempt-1).
    max_delay_secs:
        Hard ceiling on the computed backoff delay.
    """

    max_attempts: int = _DLQ_MAX_RETRIES
    base_delay_secs: float = _DLQ_BASE_DELAY_SECS
    backoff_factor: float = _DLQ_BACKOFF_FACTOR
    max_delay_secs: float = _DLQ_MAX_DELAY_SECS

    def delay_for(self, attempt: int) -> float:
        """Return the backoff delay in seconds for *attempt* (1-indexed)."""
        delay = self.base_delay_secs * (self.backoff_factor ** (attempt - 1))
        return min(delay, self.max_delay_secs)

    def exhausted(self, attempt: int) -> bool:
        """Return ``True`` if no more retries remain after *attempt*."""
        return attempt >= self.max_attempts


@dataclass
class DLQEntry:
    """Serialisable record stored in the Redis DLQ.

    Attributes
    ----------
    entry_id:
        Monotonically increasing ID within the current process.
    payload_b64:
        Base-64-encoded raw ingestion payload bytes.
    error_type:
        ``type(exc).__name__`` of the exception that caused the failure.
    error_message:
        Human-readable exception message.
    traceback_str:
        Full traceback as a string (may be empty for non-exception failures).
    source:
        Logical label for the ingestion source (e.g. ``"ledger-stream"``).
    attempt:
        Number of processing attempts so far (starts at 1).
    max_attempts:
        Maximum attempts allowed by the :class:`RetryPolicy`.
    enqueued_at:
        ISO-8601 UTC timestamp of first enqueue.
    next_retry_at:
        ISO-8601 UTC timestamp of the next scheduled retry, or ``None``
        if permanently failed.
    permanently_failed:
        ``True`` once all retry attempts are exhausted.
    trace_context:
        W3C ``traceparent``/``tracestate`` headers captured from the span
        that was active when this entry was first created (Issue #760).
        Restored as the parent context when the entry is later replayed, so
        a payload retried minutes or days after the original failure still
        shows up as part of the original request's trace instead of
        starting a disconnected one. ``None`` when tracing is disabled.
    """

    entry_id: int
    payload_b64: str
    error_type: str
    error_message: str
    traceback_str: str
    source: str
    attempt: int
    max_attempts: int
    enqueued_at: str
    next_retry_at: Optional[str]
    permanently_failed: bool = False
    trace_context: Optional[Dict[str, str]] = None

    @classmethod
    def create(
        cls,
        *,
        entry_id: int,
        raw_payload: bytes,
        exc: Optional[BaseException],
        source: str,
        attempt: int,
        policy: RetryPolicy,
        tb_str: str = "",
        trace_context: Optional[Dict[str, str]] = None,
    ) -> "DLQEntry":
            """Factory method to build a ``DLQEntry`` from an ingestion exception."""
        now = datetime.now(timezone.utc)
        enqueued_at = now.isoformat()
        perm_failed = policy.exhausted(attempt)
        delay = 0.0 if perm_failed else policy.delay_for(attempt)
        next_retry_ts: Optional[str] = None
        if not perm_failed:
            import datetime as _dt
            retry_time = now + _dt.timedelta(seconds=delay)
            next_retry_ts = retry_time.isoformat()

        # Preserve the trace context across retries of the *same* logical
        # failure (the caller passes the original one back in); only capture
        # a fresh one from the active span on the first attempt.
        resolved_trace_context = trace_context if trace_context is not None else _capture_trace_context()

        return cls(
            entry_id=entry_id,
            payload_b64=base64.b64encode(raw_payload).decode(),
            error_type=type(exc).__name__ if exc else "UnknownError",
            error_message=str(exc) if exc else "No exception captured",
            traceback_str=tb_str,
            source=source,
            attempt=attempt,
            max_attempts=policy.max_attempts,
            enqueued_at=enqueued_at,
            next_retry_at=next_retry_ts,
            permanently_failed=perm_failed,
            trace_context=resolved_trace_context,
        )

    @property
    def raw_payload(self) -> bytes:
        """Decode the base-64 payload back to raw bytes."""
        return base64.b64decode(self.payload_b64)

    def to_json(self) -> str:
        """Serialise this entry to a JSON string for Redis storage."""
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, data: str) -> "DLQEntry":
        """Deserialise a ``DLQEntry`` from a JSON string."""
        return cls(**json.loads(data))


@dataclass
class DLQStats:
    """Snapshot of DLQ metrics for the admin inspection endpoint."""

    total_entries: int
    pending_entries: int
    permanently_failed_entries: int
    oldest_entry_at: Optional[str]
    newest_entry_at: Optional[str]
    redis_key: str


# ---------------------------------------------------------------------------
# Core DLQ implementation
# ---------------------------------------------------------------------------


class RedisDLQ:
    """Redis-backed Dead-Letter Queue with exponential backoff retry.

    Parameters
    ----------
    redis_url:
        Redis connection URL (e.g. ``redis://localhost:6379/0``).
        Falls back to the ``REDIS_URL`` environment variable, then
        ``redis://localhost:6379/0``.
    redis_key:
        Redis list key used to store DLQ entries.
    max_size:
        Maximum entries retained (oldest are evicted).
    policy:
        :class:`RetryPolicy` governing backoff behaviour.
    """

    def __init__(
        self,
        *,
        redis_url: Optional[str] = None,
        redis_key: str = _DLQ_REDIS_KEY,
        max_size: int = _DLQ_MAX_SIZE,
        policy: Optional[RetryPolicy] = None,
    ) -> None:
        self._redis_url = (
            redis_url
            or os.environ.get("REDIS_URL")
            or "redis://localhost:6379/0"
        )
        self._key = redis_key
        self._max_size = max_size
        self._policy = policy or RetryPolicy()
        self._redis: Any = None  # lazy-initialised aioredis connection
        self._seq: int = 0
        self._seq_lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    async def _get_redis(self):
        """Return (and lazily create) the async Redis connection."""
        if self._redis is None:
            try:
                import redis.asyncio as aioredis  # type: ignore
                self._redis = await aioredis.from_url(
                    self._redis_url, decode_responses=True
                )
                logger.info("[DLQ] Connected to Redis at %s", self._redis_url)
            except ImportError as exc:
                raise RuntimeError(
                    "redis[asyncio] is required for RedisDLQ. "
                    "Install it with: pip install redis[asyncio]"
                ) from exc
        return self._redis

    async def close(self) -> None:
        """Close the Redis connection."""
        if self._redis is not None:
            await self._redis.aclose()
            self._redis = None

    # ------------------------------------------------------------------
    # Primary public API
    # ------------------------------------------------------------------

    async def push(
        self,
        raw_payload: bytes,
        *,
        exc: Optional[BaseException] = None,
        source: str = "ingestion-pipeline",
        attempt: int = 1,
        tb_str: str = "",
        trace_context: Optional[Dict[str, str]] = None,    
    ) -> DLQEntry:
        """Push a failed payload onto the DLQ.

        Parameters
        ----------
        raw_payload:
            The raw bytes of the ingestion message that failed.
        exc:
            The exception that caused the failure (may be ``None``).
        source:
            Logical label for the ingestion subsystem.
        attempt:
            Current attempt number (1-indexed).
        tb_str:
            Optional pre-formatted traceback string.
        trace_context:
            W3C trace headers to stamp on the entry. When omitted, the
            currently active span's context is captured automatically
            (Issue #760) — pass the original entry's ``trace_context``
            explicitly when re-pushing during a replay so the link back to
            the first failure isn't lost.

        Returns
        -------
        DLQEntry
            The entry that was stored in Redis.
        """
        async with self._seq_lock:
            self._seq += 1
            entry_id = self._seq

        entry = DLQEntry.create(
            entry_id=entry_id,
            raw_payload=raw_payload,
            exc=exc,
            source=source,
            attempt=attempt,
            policy=self._policy,
            tb_str=tb_str,
            trace_context=trace_context,
        )
        redis = await self._get_redis()
        # Append to the right; trim to max_size from the left
        pipe = redis.pipeline()
        pipe.rpush(self._key, entry.to_json())
        pipe.ltrim(self._key, -self._max_size, -1)
        await pipe.execute()

        if entry.permanently_failed:
            logger.error(
                "[DLQ] Payload permanently failed after %d/%d attempt(s) "
                "(source=%s, error=%s: %s)",
                attempt,
                self._policy.max_attempts,
                source,
                entry.error_type,
                entry.error_message,
            )
        else:
            logger.warning(
                "[DLQ] Pushed failed payload to DLQ "
                "(entry_id=%d, source=%s, attempt=%d/%d, "
                "next_retry=%s, error=%s: %s)",
                entry_id,
                source,
                attempt,
                self._policy.max_attempts,
                entry.next_retry_at,
                entry.error_type,
                entry.error_message,
            )

        return entry

    async def list_entries(
        self,
        *,
        start: int = 0,
        end: int = 99,
        include_permanently_failed: bool = True,
    ) -> List[DLQEntry]:
        """Return a slice of entries from the DLQ.

        Parameters
        ----------
        start:
            Redis list start index (0-based).
        end:
            Redis list end index (inclusive).
        include_permanently_failed:
            If ``False``, only pending (retriable) entries are returned.

        Returns
        -------
        list[DLQEntry]
            Deserialised entries, oldest first.
        """
        redis = await self._get_redis()
        raw_entries: List[str] = await redis.lrange(self._key, start, end)
        entries = []
        for raw in raw_entries:
            try:
                entry = DLQEntry.from_json(raw)
                if include_permanently_failed or not entry.permanently_failed:
                    entries.append(entry)
            except Exception as exc:
                logger.error("[DLQ] Failed to deserialise DLQ entry: %s", exc)
        return entries

    async def get_entry(self, entry_id: int) -> Optional[DLQEntry]:
        """Scan the DLQ for a specific entry by its ``entry_id``.

        This is O(n) and intended for manual admin replay operations,
        not hot-path ingestion.
        """
        redis = await self._get_redis()
        # Scan all entries — DLQ is expected to be small for admin ops
        raw_entries: List[str] = await redis.lrange(self._key, 0, -1)
        for raw in raw_entries:
            try:
                entry = DLQEntry.from_json(raw)
                if entry.entry_id == entry_id:
                    return entry
            except Exception:
                continue
        return None

    async def stats(self) -> DLQStats:
        """Return a :class:`DLQStats` snapshot for the admin endpoint."""
        redis = await self._get_redis()
        total: int = await redis.llen(self._key)
        raw_entries: List[str] = await redis.lrange(self._key, 0, -1)

        pending = 0
        perm_failed = 0
        oldest_at: Optional[str] = None
        newest_at: Optional[str] = None

        for raw in raw_entries:
            try:
                entry = DLQEntry.from_json(raw)
                if entry.permanently_failed:
                    perm_failed += 1
                else:
                    pending += 1
                if oldest_at is None:
                    oldest_at = entry.enqueued_at
                newest_at = entry.enqueued_at
            except Exception:
                continue

        return DLQStats(
            total_entries=total,
            pending_entries=pending,
            permanently_failed_entries=perm_failed,
            oldest_entry_at=oldest_at,
            newest_entry_at=newest_at,
            redis_key=self._key,
        )

    async def purge(self) -> int:
        """Delete all entries from the DLQ. Returns the count deleted."""
        redis = await self._get_redis()
        count: int = await redis.llen(self._key)
        await redis.delete(self._key)
        logger.warning("[DLQ] Purged %d entries from DLQ key '%s'", count, self._key)
        return count

    # ------------------------------------------------------------------
    # Exponential backoff retry engine
    # ------------------------------------------------------------------

    async def retry_with_backoff(
        self,
        raw_payload: bytes,
        processor: Callable[[bytes], Awaitable[None]],
        *,
        source: str = "ingestion-pipeline",
        trace_context: Optional[Dict[str, str]] = None,
    ) -> bool:
        """Attempt to process *raw_payload* with exponential backoff retries.

        On each failure the payload is (re-)pushed to the DLQ with an
        incremented attempt counter.  If all attempts are exhausted the
        final entry is marked ``permanently_failed = True``.

        Parameters
        ----------
        raw_payload:
            The raw bytes to process.
        processor:
            Async callable that processes *raw_payload*.  Must raise on
            failure.
        source:
            Logical label for the ingestion subsystem (used in DLQ entries).
        trace_context:
            W3C trace headers (Issue #760) identifying the trace this
            payload originally failed under. Pass the stored
            ``DLQEntry.trace_context`` here when replaying an entry from the
            admin endpoint so the retry span is linked back to the original
            request/task instead of starting a disconnected trace. Leave
            unset for a first-attempt call — the current active context is
            used automatically.

        Returns
        -------
        bool
            ``True`` if processing eventually succeeded, ``False`` if all
            attempts were exhausted.
        """
        parent_ctx = _extract_trace_context(trace_context)
        for attempt in range(1, self._policy.max_attempts + 1):
            try:
                async with _dlq_span(
                    "dlq.process_payload",
                    parent_ctx,
                    {"dlq.source": source, "dlq.attempt": attempt, "dlq.max_attempts": self._policy.max_attempts},
                ):
                    await processor(raw_payload)
                logger.info(
                    "[DLQ] Payload processed successfully on attempt %d/%d (source=%s)",
                    attempt,
                    self._policy.max_attempts,
                    source,
                )
                return True
            except Exception as exc:  # noqa: BLE001
                tb_str = traceback.format_exc()
                entry = await self.push(
                    raw_payload,
                    exc=exc,
                    source=source,
                    attempt=attempt,
                    tb_str=tb_str,
                    trace_context=trace_context,
                )
                if entry.permanently_failed:
                    logger.error(
                        "[DLQ] All %d attempt(s) exhausted for payload "
                        "(source=%s). Payload permanently failed.",
                        self._policy.max_attempts,
                        source,
                    )
                    return False

                delay = self._policy.delay_for(attempt)
                logger.warning(
                    "[DLQ] Attempt %d/%d failed (source=%s, error=%s). "
                    "Retrying in %.1fs…",
                    attempt,
                    self._policy.max_attempts,
                    source,
                    type(exc).__name__,
                    delay,
                )
                await asyncio.sleep(delay)

        return False  # unreachable but satisfies type checkers


# ---------------------------------------------------------------------------
# REST request/response helpers (framework-agnostic dicts)
# ---------------------------------------------------------------------------


async def handle_dlq_inspect(dlq: RedisDLQ, query: Dict[str, Any]) -> Dict[str, Any]:
    """Handler for ``GET /api/v1/admin/dlq``.

    Parameters
    ----------
    dlq:
        Active :class:`RedisDLQ` instance.
    query:
        Parsed query parameters from the HTTP request.

    Returns
    -------
    dict
        JSON-serialisable response body.
    """
    try:
        start = int(query.get("start", 0))
        end = int(query.get("end", 99))
        include_failed = str(query.get("include_failed", "true")).lower() != "false"
    except (ValueError, TypeError) as exc:
        return {
            "success": False,
            "error": "BAD_REQUEST",
            "message": f"Invalid query parameters: {exc}",
        }

    entries = await dlq.list_entries(
        start=start,
        end=end,
        include_permanently_failed=include_failed,
    )
    stats = await dlq.stats()

    return {
        "success": True,
        "stats": asdict(stats),
        "entries": [asdict(e) for e in entries],
        "page": {"start": start, "end": end, "count": len(entries)},
    }


async def handle_dlq_replay(
    dlq: RedisDLQ,
    processor: Callable[[bytes], Awaitable[None]],
    body: Dict[str, Any],
) -> Dict[str, Any]:
    """Handler for ``POST /api/v1/admin/dlq/replay``.

    Parameters
    ----------
    dlq:
        Active :class:`RedisDLQ` instance.
    processor:
        Async callable that processes a single raw payload.
    body:
        Parsed JSON request body.  Recognised keys:

        ``entry_id`` (int, optional)
            Replay a single entry by ID.  If omitted, replay all pending
            entries.
        ``purge_on_success`` (bool, optional)
            If ``True``, the DLQ is purged after a successful full replay.

    Returns
    -------
    dict
        JSON-serialisable response body.
    """
    entry_id: Optional[int] = body.get("entry_id")
    purge_on_success: bool = bool(body.get("purge_on_success", False))

    results = []

    if entry_id is not None:
        # Replay a single entry
        entry = await dlq.get_entry(entry_id)
        if entry is None:
            return {
                "success": False,
                "error": "NOT_FOUND",
                "message": f"DLQ entry {entry_id} not found.",
            }
        success = await dlq.retry_with_backoff(
            entry.raw_payload, processor, source=entry.source, trace_context=entry.trace_context
        )
        results.append({"entry_id": entry_id, "success": success})
    else:
        # Replay all pending entries
        entries = await dlq.list_entries(include_permanently_failed=False)
        for entry in entries:
            success = await dlq.retry_with_backoff(
                entry.raw_payload, processor, source=entry.source, trace_context=entry.trace_context
            )
            results.append({"entry_id": entry.entry_id, "success": success})

        if purge_on_success and all(r["success"] for r in results):
            purged = await dlq.purge()
            return {
                "success": True,
                "message": f"Replayed {len(results)} entries; DLQ purged ({purged} entries removed).",
                "results": results,
            }

    succeeded = sum(1 for r in results if r["success"])
    failed = len(results) - succeeded
    return {
        "success": True,
        "message": f"Replay complete: {succeeded} succeeded, {failed} failed.",
        "results": results,
    }


# ---------------------------------------------------------------------------
# Decorator helper
# ---------------------------------------------------------------------------


def with_dlq_fallback(
    dlq: RedisDLQ,
    *,
    source: str = "ingestion-pipeline",
    use_backoff: bool = True,
) -> Callable:
    """Decorator that wraps an async ingestion processor with DLQ fallback.

    If the wrapped coroutine raises, the raw payload is pushed to *dlq*
    (optionally with exponential backoff retries).

    Usage::

        @with_dlq_fallback(dlq, source="ledger-stream")
        async def process_ledger_event(raw: bytes) -> None:
            parsed = json.loads(raw)
            await ingest(parsed)

    Parameters
    ----------
    dlq:
        Active :class:`RedisDLQ` instance.
    source:
        Logical label for the ingestion subsystem.
    use_backoff:
        If ``True`` (default), applies exponential backoff retries before
        pushing to the DLQ.  If ``False``, pushes immediately on first failure.
    """

    def decorator(fn: Callable[[bytes], Awaitable[None]]) -> Callable[[bytes], Awaitable[None]]:
        async def wrapper(raw_payload: bytes) -> None:
            if use_backoff:
                await dlq.retry_with_backoff(raw_payload, fn, source=source)
            else:
                try:
                    await fn(raw_payload)
                except Exception as exc:
                    tb_str = traceback.format_exc()
                    await dlq.push(
                        raw_payload,
                        exc=exc,
                        source=source,
                        attempt=1,
                        tb_str=tb_str,
                    )

        wrapper.__name__ = fn.__name__
        wrapper.__doc__ = fn.__doc__
        return wrapper

    return decorator


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_dlq_instance: Optional[RedisDLQ] = None
_dlq_lock = asyncio.Lock()


def configure_dlq(
    *,
    redis_url: Optional[str] = None,
    redis_key: str = _DLQ_REDIS_KEY,
    max_size: int = _DLQ_MAX_SIZE,
    policy: Optional[RetryPolicy] = None,
) -> RedisDLQ:
    """Create or replace the module-level DLQ singleton.

    Call this once at application startup before any ingestion begins.
    """
    global _dlq_instance
    _dlq_instance = RedisDLQ(
        redis_url=redis_url,
        redis_key=redis_key,
        max_size=max_size,
        policy=policy,
    )
    logger.info("[DLQ] Configured RedisDLQ (key=%s, max_size=%d)", redis_key, max_size)
    return _dlq_instance


def get_dlq() -> RedisDLQ:
    """Return the module-level DLQ singleton, creating it with defaults if needed."""
    global _dlq_instance
    if _dlq_instance is None:
        _dlq_instance = RedisDLQ()
    return _dlq_instance
