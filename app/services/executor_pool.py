"""app/services/executor_pool.py

Issue #XXX — Multi-Threaded Heavy Task Execution Pool for CPU-Bound Jobs

Provides managed ProcessPoolExecutor and ThreadPoolExecutor worker pools
for offloading CPU-heavy operations from the FastAPI event loop.

Architecture
------------
1. **Heavy pool** (ProcessPoolExecutor)
   - ZK proof verification (pairing checks, elliptic-curve ops).
   - Cryptographic signature verification (Ed25519, etc.).
   - Uses separate OS processes to avoid GIL contention.

2. **Light pool** (ThreadPoolExecutor)
   - Lightweight crypto operations, HMAC, hashing.
   - Uses OS threads; suitable for I/O-bound or lightly CPU-bound work.

3. **Async wrappers**
   - ``run_in_heavy_pool`` / ``run_in_light_pool`` bridge sync workers
     into async awaitable coroutines.

4. **Event-loop latency monitor**
   - Periodically probes event-loop responsiveness.
   - Logs warnings when latency exceeds the configured budget.
"""

from __future__ import annotations

import asyncio
import os
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from functools import partial
from typing import Any, Callable, Optional

import structlog

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

#: Worker count for the heavy (process) pool.  Defaults to CPU core count.
HEAVY_POOL_WORKERS: int = int(
    os.getenv("HEAVY_POOL_WORKERS", str(os.cpu_count() or 4))
)

#: Worker count for the light (thread) pool.
LIGHT_POOL_WORKERS: int = int(os.getenv("LIGHT_POOL_WORKERS", "8"))

#: Maximum acceptable event-loop scheduling latency (milliseconds).
LATENCY_BUDGET_MS: float = float(os.getenv("LATENCY_BUDGET_MS", "5.0"))

#: How often the latency monitor probes the event loop.
LATENCY_PROBE_INTERVAL_SECS: float = float(
    os.getenv("LATENCY_PROBE_INTERVAL_SECS", "0.1")
)

# ---------------------------------------------------------------------------
# Singleton pools (lazy, thread-safe)
# ---------------------------------------------------------------------------

_heavy_pool: Optional[ProcessPoolExecutor] = None
_light_pool: Optional[ThreadPoolExecutor] = None
_pool_lock: Any = None

try:
    import threading

    _pool_lock = threading.Lock()
except ImportError:  # pragma: no cover
    _pool_lock = None


def get_heavy_pool() -> ProcessPoolExecutor:
    """Return (or lazily create) the heavy ProcessPoolExecutor."""
    global _heavy_pool
    if _heavy_pool is None:
        if _pool_lock is not None:
            with _pool_lock:
                if _heavy_pool is None:
                    _heavy_pool = ProcessPoolExecutor(max_workers=HEAVY_POOL_WORKERS)
        else:
            _heavy_pool = ProcessPoolExecutor(max_workers=HEAVY_POOL_WORKERS)
        log.info(
            "executor_pool.heavy_pool.started",
            component="ExecutorPool",
            workers=HEAVY_POOL_WORKERS,
        )
    return _heavy_pool


def get_light_pool() -> ThreadPoolExecutor:
    """Return (or lazily create) the light ThreadPoolExecutor."""
    global _light_pool
    if _light_pool is None:
        if _pool_lock is not None:
            with _pool_lock:
                if _light_pool is None:
                    _light_pool = ThreadPoolExecutor(max_workers=LIGHT_POOL_WORKERS)
        else:
            _light_pool = ThreadPoolExecutor(max_workers=LIGHT_POOL_WORKERS)
        log.info(
            "executor_pool.light_pool.started",
            component="ExecutorPool",
            workers=LIGHT_POOL_WORKERS,
        )
    return _light_pool


def shutdown_pools() -> None:
    """Cleanly shut down both worker pools."""
    global _heavy_pool, _light_pool
    if _heavy_pool is not None:
        _heavy_pool.shutdown(wait=True, cancel_futures=False)
        _heavy_pool = None
        log.info("executor_pool.heavy_pool.shutdown", component="ExecutorPool")
    if _light_pool is not None:
        _light_pool.shutdown(wait=True, cancel_futures=False)
        _light_pool = None
        log.info("executor_pool.light_pool.shutdown", component="ExecutorPool")


# ---------------------------------------------------------------------------
# Async wrappers
# ---------------------------------------------------------------------------


async def run_in_heavy_pool(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Execute *fn* in the heavy ProcessPoolExecutor.

    ``functools.partial`` is used so the call remains picklable for
    process-based workers.
    """
    pool = get_heavy_pool()
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(pool, partial(fn, *args, **kwargs))


async def run_in_light_pool(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Execute *fn* in the light ThreadPoolExecutor."""
    pool = get_light_pool()
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(pool, partial(fn, *args, **kwargs))


# ---------------------------------------------------------------------------
# Event-loop latency monitor
# ---------------------------------------------------------------------------


class EventLoopLatencyMonitor:
    """Probes event-loop responsiveness and logs warnings on budget violations."""

    def __init__(
        self,
        budget_ms: float = LATENCY_BUDGET_MS,
        interval_secs: float = LATENCY_PROBE_INTERVAL_SECS,
        max_samples: int = 1000,
    ) -> None:
        self._budget_ms = budget_ms
        self._interval = interval_secs
        self._max_samples = max_samples
        self._samples: list[float] = []
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._violations = 0

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._probe_loop())
        log.info(
            "latency_monitor.started",
            component="LatencyMonitor",
            budget_ms=self._budget_ms,
            interval_secs=self._interval,
        )

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        log.info("latency_monitor.stopped", component="LatencyMonitor")

    async def _probe_loop(self) -> None:
        loop = asyncio.get_running_loop()
        while self._running:
            probe_start = time.monotonic()
            probe_event = asyncio.Event()

            def _fire_probe() -> None:
                probe_event.set()

            loop.call_later(0, _fire_probe)
            try:
                await asyncio.wait_for(probe_event.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass

            latency_ms = (time.monotonic() - probe_start) * 1000
            self._samples.append(latency_ms)
            if len(self._samples) > self._max_samples:
                self._samples.pop(0)

            if latency_ms > self._budget_ms:
                self._violations += 1
                log.warning(
                    "latency_monitor.budget_exceeded",
                    component="LatencyMonitor",
                    latency_ms=round(latency_ms, 3),
                    budget_ms=self._budget_ms,
                    violations=self._violations,
                )

            await asyncio.sleep(self._interval)

    @property
    def max_latency_ms(self) -> float:
        return max(self._samples) if self._samples else 0.0

    @property
    def avg_latency_ms(self) -> float:
        return sum(self._samples) / len(self._samples) if self._samples else 0.0

    @property
    def violation_count(self) -> int:
        return self._violations

    @property
    def is_healthy(self) -> bool:
        return self.max_latency_ms < self._budget_ms


# ---------------------------------------------------------------------------
# Module-level singleton monitor
# ---------------------------------------------------------------------------

_latency_monitor: Optional[EventLoopLatencyMonitor] = None


def get_latency_monitor() -> EventLoopLatencyMonitor:
    global _latency_monitor
    if _latency_monitor is None:
        _latency_monitor = EventLoopLatencyMonitor()
    return _latency_monitor


async def start_latency_monitor() -> EventLoopLatencyMonitor:
    monitor = get_latency_monitor()
    await monitor.start()
    return monitor


async def stop_latency_monitor() -> None:
    monitor = get_latency_monitor()
    await monitor.stop()


__all__ = [
    "HEAVY_POOL_WORKERS",
    "LIGHT_POOL_WORKERS",
    "LATENCY_BUDGET_MS",
    "get_heavy_pool",
    "get_light_pool",
    "shutdown_pools",
    "run_in_heavy_pool",
    "run_in_light_pool",
    "EventLoopLatencyMonitor",
    "get_latency_monitor",
    "start_latency_monitor",
    "stop_latency_monitor",
]
