"""Soroban RPC Node Latency & Health Matrix Exporter.

Issue #1294 — Build Soroban RPC Node Latency & Health Matrix Exporter

Background worker that monitors response times, block synchronisation heights,
and error rates across all configured Soroban RPC nodes. Metrics are exported to
Prometheus so that the dynamic load balancer can route traffic away from lagging
or degraded RPC instances.

Behaviour
---------
- Pings every configured Soroban RPC node every ``SOROBAN_HEALTH_CHECK_INTERVAL_S``
  seconds (default 5 s) using the standard JSON-RPC ``getHealth`` and
  ``getLatestLedger`` methods.
- Records response latency, current ledger sequence height, and cumulative error
  counts as labelled Prometheus metrics.
- Exposes a ``SorobanRPCHealthMatrix`` singleton that the Celery beat task, the
  FastAPI lifespan hook, and the REST router all share via ``get_health_matrix()``.

Environment variables
---------------------
SOROBAN_RPC_URL
    Primary Soroban RPC endpoint (e.g. ``https://soroban-testnet.stellar.org``).
    Falls back to ``RPC_URL`` when unset.
SOROBAN_FALLBACK_RPC_URLS
    Comma-separated list of backup Soroban RPC endpoints.
    Falls back to ``FALLBACK_RPC_URLS`` when unset.
SOROBAN_HEALTH_CHECK_INTERVAL_S
    Seconds between health check rounds (default ``5``).
SOROBAN_HEALTH_CHECK_TIMEOUT_S
    Per-request timeout in seconds (default ``3``).
SOROBAN_LATENCY_DEGRADED_MS
    Response-time threshold above which a node is flagged as degraded (default ``2000``).
SOROBAN_MAX_LEDGER_LAG
    Maximum tolerated ledger height lag behind the best-known tip before a node
    is flagged as lagging (default ``10``).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

import aiohttp
from prometheus_client import Counter, Gauge, Histogram

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------

_DEFAULT_PRIMARY_RPC = "https://soroban-testnet.stellar.org"
_DEFAULT_INTERVAL_S = 5.0
_DEFAULT_TIMEOUT_S = 3.0
_DEFAULT_DEGRADED_MS = 2000.0
_DEFAULT_MAX_LEDGER_LAG = 10
_LATENCY_HISTORY_LEN = 100


def _rpc_nodes_from_env() -> List[str]:
    """Return the full ordered list of configured Soroban RPC endpoints."""
    primary = (
        os.getenv("SOROBAN_RPC_URL")
        or os.getenv("RPC_URL")
        or _DEFAULT_PRIMARY_RPC
    )
    fallbacks_raw = (
        os.getenv("SOROBAN_FALLBACK_RPC_URLS")
        or os.getenv("FALLBACK_RPC_URLS")
        or ""
    )
    fallbacks = [u.strip() for u in fallbacks_raw.split(",") if u.strip()]
    # Deduplicate while preserving order: primary always first
    seen: set[str] = {primary}
    result = [primary]
    for url in fallbacks:
        if url not in seen:
            seen.add(url)
            result.append(url)
    return result


# ---------------------------------------------------------------------------
# Prometheus metrics
# ---------------------------------------------------------------------------

# Response-time histogram per node (labels: node_url)
SOROBAN_RPC_LATENCY_SECONDS = Histogram(
    name="soroban_rpc_latency_seconds",
    documentation="Soroban RPC node response latency in seconds",
    labelnames=["node_url"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0),
)

# Current ledger sequence reported by each node
SOROBAN_RPC_LEDGER_SEQUENCE = Gauge(
    name="soroban_rpc_ledger_sequence",
    documentation="Latest ledger sequence number reported by a Soroban RPC node",
    labelnames=["node_url"],
)

# Ledger lag behind the best-known tip across all nodes
SOROBAN_RPC_LEDGER_LAG = Gauge(
    name="soroban_rpc_ledger_lag",
    documentation="Ledger sequence lag of a node behind the highest observed tip",
    labelnames=["node_url"],
)

# Cumulative error counter per node (labels: node_url, error_type)
SOROBAN_RPC_ERRORS_TOTAL = Counter(
    name="soroban_rpc_errors_total",
    documentation="Total Soroban RPC health-check errors per node",
    labelnames=["node_url", "error_type"],
)

# Binary health gauge: 1 = healthy, 0 = unhealthy
SOROBAN_RPC_NODE_HEALTHY = Gauge(
    name="soroban_rpc_node_healthy",
    documentation="1 if the Soroban RPC node is considered healthy, 0 otherwise",
    labelnames=["node_url"],
)

# Total health-check probes sent (success + failure)
SOROBAN_RPC_CHECKS_TOTAL = Counter(
    name="soroban_rpc_checks_total",
    documentation="Total Soroban RPC health-check probes dispatched per node",
    labelnames=["node_url", "result"],  # result: "success" | "error"
)

# Average latency gauge (convenience for dashboards that prefer gauges)
SOROBAN_RPC_AVG_LATENCY_MS = Gauge(
    name="soroban_rpc_avg_latency_ms",
    documentation="Rolling average Soroban RPC response latency in milliseconds",
    labelnames=["node_url"],
)

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class NodeHealthSnapshot:
    """Point-in-time health snapshot for a single Soroban RPC node."""

    node_url: str
    is_healthy: bool
    latency_ms: float
    ledger_sequence: Optional[int]
    ledger_lag: int
    error_count: int
    consecutive_failures: int
    last_check_at: Optional[datetime]
    last_success_at: Optional[datetime]
    avg_latency_ms: float
    p95_latency_ms: float
    rpc_status: Optional[str]  # raw "status" field from getHealth response


@dataclass
class _NodeState:
    """Internal mutable state tracked per node between check rounds."""

    url: str
    latency_samples: deque = field(default_factory=lambda: deque(maxlen=_LATENCY_HISTORY_LEN))
    error_count: int = 0
    consecutive_failures: int = 0
    last_check_at: Optional[datetime] = None
    last_success_at: Optional[datetime] = None
    last_ledger_sequence: Optional[int] = None
    last_rpc_status: Optional[str] = None
    is_healthy: bool = True

    @property
    def avg_latency_ms(self) -> float:
        if not self.latency_samples:
            return 0.0
        return sum(self.latency_samples) / len(self.latency_samples)

    @property
    def p95_latency_ms(self) -> float:
        if not self.latency_samples:
            return 0.0
        sorted_samples = sorted(self.latency_samples)
        idx = max(0, int(len(sorted_samples) * 0.95) - 1)
        return sorted_samples[idx]


# ---------------------------------------------------------------------------
# Core worker
# ---------------------------------------------------------------------------


class SorobanRPCHealthMatrix:
    """Monitor latency, ledger height, and error rates across Soroban RPC nodes.

    This class is designed to be used as a long-lived singleton. Callers should
    use ``get_health_matrix()`` rather than constructing it directly.

    Usage (FastAPI lifespan)::

        matrix = get_health_matrix()
        await matrix.start()
        ...
        await matrix.stop()

    Usage (Celery task — one-shot poll)::

        matrix = get_health_matrix()
        results = await matrix.poll_once()
    """

    def __init__(
        self,
        node_urls: Optional[List[str]] = None,
        *,
        interval_s: float = _DEFAULT_INTERVAL_S,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
        latency_degraded_ms: float = _DEFAULT_DEGRADED_MS,
        max_ledger_lag: int = _DEFAULT_MAX_LEDGER_LAG,
    ) -> None:
        self._node_urls: List[str] = node_urls or _rpc_nodes_from_env()
        self._interval_s = interval_s
        self._timeout_s = timeout_s
        self._latency_degraded_ms = latency_degraded_ms
        self._max_ledger_lag = max_ledger_lag

        # Per-node mutable state
        self._states: Dict[str, _NodeState] = {
            url: _NodeState(url=url) for url in self._node_urls
        }

        self._running = False
        self._task: Optional[asyncio.Task] = None  # type: ignore[type-arg]

        log.info(
            "[SorobanRPCHealthMatrix] Initialised | nodes=%d | interval=%.1fs | timeout=%.1fs",
            len(self._node_urls),
            self._interval_s,
            self._timeout_s,
        )

    # ------------------------------------------------------------------
    # Public lifecycle API
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the continuous background polling loop."""
        if self._running:
            log.warning("[SorobanRPCHealthMatrix] Already running — ignoring start()")
            return
        self._running = True
        self._task = asyncio.create_task(self._poll_loop(), name="soroban-rpc-health-matrix")
        log.info("[SorobanRPCHealthMatrix] Background polling started")

    async def stop(self) -> None:
        """Gracefully stop the background polling loop."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        log.info("[SorobanRPCHealthMatrix] Background polling stopped")

    # ------------------------------------------------------------------
    # One-shot poll (used by Celery beat task)
    # ------------------------------------------------------------------

    async def poll_once(self) -> List[NodeHealthSnapshot]:
        """Perform a single health-check round across all nodes.

        Returns a list of :class:`NodeHealthSnapshot` objects — one per node —
        and updates Prometheus metrics. Safe to call from synchronous code via
        ``asyncio.run(matrix.poll_once())``.
        """
        connector = aiohttp.TCPConnector(ssl=False)
        timeout = aiohttp.ClientTimeout(total=self._timeout_s)
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            tasks = [self._check_node(session, url) for url in self._node_urls]
            results = await asyncio.gather(*tasks, return_exceptions=True)

        snapshots: List[NodeHealthSnapshot] = []
        for url, result in zip(self._node_urls, results):
            if isinstance(result, Exception):
                # Unexpected error inside _check_node — treat as network failure
                state = self._states[url]
                state.error_count += 1
                state.consecutive_failures += 1
                state.is_healthy = False
                state.last_check_at = datetime.now(timezone.utc)
                SOROBAN_RPC_ERRORS_TOTAL.labels(node_url=url, error_type="unexpected").inc()
                SOROBAN_RPC_CHECKS_TOTAL.labels(node_url=url, result="error").inc()
                SOROBAN_RPC_NODE_HEALTHY.labels(node_url=url).set(0)
                log.error(
                    "[SorobanRPCHealthMatrix] Unexpected error for %s: %s", url, result
                )
            else:
                snapshots.append(result)

        self._update_ledger_lag(snapshots)
        return snapshots

    # ------------------------------------------------------------------
    # Read-only accessors
    # ------------------------------------------------------------------

    def get_all_snapshots(self) -> List[NodeHealthSnapshot]:
        """Return the latest health snapshot for every configured node."""
        snapshots = []
        best_ledger = self._best_ledger_sequence()
        for url, state in self._states.items():
            lag = 0
            if state.last_ledger_sequence is not None and best_ledger is not None:
                lag = max(0, best_ledger - state.last_ledger_sequence)
            snapshots.append(
                NodeHealthSnapshot(
                    node_url=url,
                    is_healthy=state.is_healthy,
                    latency_ms=state.latency_samples[-1] if state.latency_samples else 0.0,
                    ledger_sequence=state.last_ledger_sequence,
                    ledger_lag=lag,
                    error_count=state.error_count,
                    consecutive_failures=state.consecutive_failures,
                    last_check_at=state.last_check_at,
                    last_success_at=state.last_success_at,
                    avg_latency_ms=state.avg_latency_ms,
                    p95_latency_ms=state.p95_latency_ms,
                    rpc_status=state.last_rpc_status,
                )
            )
        return snapshots

    def get_healthy_nodes(self) -> List[str]:
        """Return URLs of nodes currently considered healthy."""
        return [url for url, state in self._states.items() if state.is_healthy]

    # ------------------------------------------------------------------
    # Internal polling helpers
    # ------------------------------------------------------------------

    async def _poll_loop(self) -> None:
        """Continuous polling loop — runs until ``stop()`` is called."""
        while self._running:
            try:
                await self.poll_once()
            except Exception as exc:
                log.error("[SorobanRPCHealthMatrix] Poll loop error: %s", exc)
            await asyncio.sleep(self._interval_s)

    async def _check_node(
        self, session: aiohttp.ClientSession, url: str
    ) -> NodeHealthSnapshot:
        """Run getHealth + getLatestLedger against *url* and update its state."""
        state = self._states[url]
        now = datetime.now(timezone.utc)
        state.last_check_at = now

        # ---- getHealth -------------------------------------------------------
        health_start = time.perf_counter()
        try:
            rpc_status = await self._call_get_health(session, url)
            latency_ms = (time.perf_counter() - health_start) * 1000
        except Exception as exc:
            latency_ms = (time.perf_counter() - health_start) * 1000
            error_type = type(exc).__name__
            state.error_count += 1
            state.consecutive_failures += 1
            state.is_healthy = False

            SOROBAN_RPC_ERRORS_TOTAL.labels(node_url=url, error_type=error_type).inc()
            SOROBAN_RPC_CHECKS_TOTAL.labels(node_url=url, result="error").inc()
            SOROBAN_RPC_NODE_HEALTHY.labels(node_url=url).set(0)
            SOROBAN_RPC_LATENCY_SECONDS.labels(node_url=url).observe(latency_ms / 1000)

            log.warning(
                "[SorobanRPCHealthMatrix] getHealth failed | url=%s | error=%s | latency_ms=%.1f",
                url,
                exc,
                latency_ms,
            )
            return self._build_snapshot(state, latency_ms=latency_ms)

        # ---- getLatestLedger -------------------------------------------------
        ledger_sequence: Optional[int] = None
        try:
            ledger_sequence = await self._call_get_latest_ledger(session, url)
            state.last_ledger_sequence = ledger_sequence
        except Exception as exc:
            # Non-fatal: we still have latency + health status
            SOROBAN_RPC_ERRORS_TOTAL.labels(node_url=url, error_type="ledger_fetch").inc()
            log.warning(
                "[SorobanRPCHealthMatrix] getLatestLedger failed | url=%s | error=%s",
                url,
                exc,
            )

        # ---- Update state ----------------------------------------------------
        state.latency_samples.append(latency_ms)
        state.consecutive_failures = 0
        state.last_success_at = now
        state.last_rpc_status = rpc_status

        degraded = latency_ms > self._latency_degraded_ms
        state.is_healthy = rpc_status == "healthy" and not degraded

        # ---- Prometheus updates ---------------------------------------------
        SOROBAN_RPC_LATENCY_SECONDS.labels(node_url=url).observe(latency_ms / 1000)
        SOROBAN_RPC_AVG_LATENCY_MS.labels(node_url=url).set(state.avg_latency_ms)
        SOROBAN_RPC_CHECKS_TOTAL.labels(node_url=url, result="success").inc()
        SOROBAN_RPC_NODE_HEALTHY.labels(node_url=url).set(1 if state.is_healthy else 0)
        if ledger_sequence is not None:
            SOROBAN_RPC_LEDGER_SEQUENCE.labels(node_url=url).set(ledger_sequence)

        log.debug(
            "[SorobanRPCHealthMatrix] check ok | url=%s | status=%s | latency_ms=%.1f | ledger=%s | healthy=%s",
            url,
            rpc_status,
            latency_ms,
            ledger_sequence,
            state.is_healthy,
        )
        return self._build_snapshot(state, latency_ms=latency_ms)

    async def _call_get_health(self, session: aiohttp.ClientSession, url: str) -> str:
        """Issue getHealth JSON-RPC call and return the ``status`` string."""
        payload = {"jsonrpc": "2.0", "id": 1, "method": "getHealth"}
        async with session.post(url, json=payload) as resp:
            resp.raise_for_status()
            body = await resp.json(content_type=None)

        # Soroban RPC returns {"result": {"status": "healthy"}} on success
        result = body.get("result") or {}
        status = result.get("status", "unknown")
        if "error" in body:
            raise RuntimeError(f"RPC error: {body['error']}")
        return str(status)

    async def _call_get_latest_ledger(
        self, session: aiohttp.ClientSession, url: str
    ) -> int:
        """Issue getLatestLedger JSON-RPC call and return the ledger sequence."""
        payload = {"jsonrpc": "2.0", "id": 2, "method": "getLatestLedger"}
        async with session.post(url, json=payload) as resp:
            resp.raise_for_status()
            body = await resp.json(content_type=None)

        if "error" in body:
            raise RuntimeError(f"RPC error: {body['error']}")
        result = body.get("result") or {}
        sequence = result.get("sequence")
        if sequence is None:
            raise ValueError(f"Missing 'sequence' in getLatestLedger response from {url}")
        return int(sequence)

    def _best_ledger_sequence(self) -> Optional[int]:
        """Return the highest ledger sequence seen across all nodes."""
        sequences = [
            s.last_ledger_sequence
            for s in self._states.values()
            if s.last_ledger_sequence is not None
        ]
        return max(sequences) if sequences else None

    def _update_ledger_lag(self, snapshots: List[NodeHealthSnapshot]) -> None:
        """Compute ledger lag for each node and update Prometheus gauges."""
        best = self._best_ledger_sequence()
        if best is None:
            return
        for state in self._states.values():
            if state.last_ledger_sequence is None:
                continue
            lag = max(0, best - state.last_ledger_sequence)
            SOROBAN_RPC_LEDGER_LAG.labels(node_url=state.url).set(lag)
            # Flag as unhealthy if lag exceeds the configured threshold
            if lag > self._max_ledger_lag and state.is_healthy:
                state.is_healthy = False
                SOROBAN_RPC_NODE_HEALTHY.labels(node_url=state.url).set(0)
                log.warning(
                    "[SorobanRPCHealthMatrix] Node lagging | url=%s | lag=%d | threshold=%d",
                    state.url,
                    lag,
                    self._max_ledger_lag,
                )

    def _build_snapshot(
        self, state: _NodeState, *, latency_ms: float
    ) -> NodeHealthSnapshot:
        best = self._best_ledger_sequence()
        lag = 0
        if state.last_ledger_sequence is not None and best is not None:
            lag = max(0, best - state.last_ledger_sequence)
        return NodeHealthSnapshot(
            node_url=state.url,
            is_healthy=state.is_healthy,
            latency_ms=latency_ms,
            ledger_sequence=state.last_ledger_sequence,
            ledger_lag=lag,
            error_count=state.error_count,
            consecutive_failures=state.consecutive_failures,
            last_check_at=state.last_check_at,
            last_success_at=state.last_success_at,
            avg_latency_ms=state.avg_latency_ms,
            p95_latency_ms=state.p95_latency_ms,
            rpc_status=state.last_rpc_status,
        )


# ---------------------------------------------------------------------------
# Singleton accessor
# ---------------------------------------------------------------------------

_health_matrix: Optional[SorobanRPCHealthMatrix] = None


def get_health_matrix() -> SorobanRPCHealthMatrix:
    """Return the process-wide :class:`SorobanRPCHealthMatrix` singleton.

    The instance is created lazily on first call, reading configuration from
    environment variables. Subsequent calls return the same object.
    """
    global _health_matrix
    if _health_matrix is None:
        _health_matrix = SorobanRPCHealthMatrix(
            interval_s=float(os.getenv("SOROBAN_HEALTH_CHECK_INTERVAL_S", str(_DEFAULT_INTERVAL_S))),
            timeout_s=float(os.getenv("SOROBAN_HEALTH_CHECK_TIMEOUT_S", str(_DEFAULT_TIMEOUT_S))),
            latency_degraded_ms=float(os.getenv("SOROBAN_LATENCY_DEGRADED_MS", str(_DEFAULT_DEGRADED_MS))),
            max_ledger_lag=int(os.getenv("SOROBAN_MAX_LEDGER_LAG", str(_DEFAULT_MAX_LEDGER_LAG))),
        )
    return _health_matrix
