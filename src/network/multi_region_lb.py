"""network/multi_region_lb.py - Multi-region RPC load balancer router.

Routes Soroban RPC requests to the nearest geographic node to reduce latency.
Each candidate node belongs to a region and is probed periodically with a
latency-based health check. Traffic is routed dynamically away from degraded
nodes, with hysteresis to avoid endpoint flapping when latencies are close.

Key features:
- Latency-based health checks across global RPC node endpoints
- Nearest-node routing: the active endpoint is the healthy node with the
  lowest smoothed latency (a practical proxy for geographic proximity)
- Dynamic routing away from degraded nodes with automatic failover
- Hysteresis margin so a marginally faster node does not cause flapping
- Routing latency stats exportable in Prometheus exposition format for
  Grafana dashboards (scrape via a /metrics endpoint, see export_prometheus)
- Thread-safe operations for concurrent access
- Integration with the existing rpc_monitor health-score model

Usage
-----
>>> from network.multi_region_lb import MultiRegionLoadBalancer, NodeEndpoint
>>> lb = MultiRegionLoadBalancer([
...     NodeEndpoint("https://soroban-testnet.stellar.org:443", "us-west"),
...     NodeEndpoint("https://eu.soroban-node.example", "eu-central"),
... ])
>>> lb.start_monitoring()
>>> lb.route("transactions", {"tx": "..."})
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Deque, Dict, List, Optional, Tuple

import requests

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULT_HEALTH_CHECK_INTERVAL_S: float = 5.0
DEFAULT_HEALTH_THRESHOLD: float = 70.0
DEFAULT_LATENCY_THRESHOLD_MS: float = 2000.0
DEFAULT_SUCCESS_RATE_THRESHOLD: float = 0.95
DEFAULT_PROBE_TIMEOUT_S: float = 2.0
DEFAULT_MAX_SAMPLES: int = 100

#: A candidate endpoint must beat the active endpoint's latency by this factor
#: to take over routing. Prevents flapping between regionally similar nodes.
DEFAULT_ROUTING_HYSTERESIS_FACTOR: float = 0.7

#: Minimum consecutive probe failures before a node is marked unhealthy.
FAILURE_THRESHOLD_FOR_UNHEALTHY: int = 3

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class NodeEndpoint:
    """A single RPC node with its geographic region label."""

    url: str
    region: str

    def __post_init__(self) -> None:
        if not self.url:
            raise ValueError("NodeEndpoint.url must be a non-empty string")
        if not self.region:
            raise ValueError("NodeEndpoint.region must be a non-empty string")


@dataclass
class NodeHealth:
    """Mutable per-node health and latency tracking state."""

    endpoint: NodeEndpoint
    latency_samples: Deque[float] = field(
        default_factory=lambda: deque(maxlen=DEFAULT_MAX_SAMPLES)
    )
    success_count: int = 0
    failure_count: int = 0
    consecutive_failures: int = 0
    last_check_time: Optional[datetime] = None
    last_success_time: Optional[datetime] = None
    health_score: float = 100.0
    is_healthy: bool = True
    error_types: Dict[str, int] = field(default_factory=dict)

    @property
    def total_requests(self) -> int:
        return self.success_count + self.failure_count

    @property
    def success_rate(self) -> float:
        if self.total_requests == 0:
            return 1.0
        return self.success_count / self.total_requests

    @property
    def avg_latency_ms(self) -> float:
        if not self.latency_samples:
            return 0.0
        return sum(self.latency_samples) / len(self.latency_samples)

    @property
    def p95_latency_ms(self) -> float:
        if not self.latency_samples:
            return 0.0
        ordered = sorted(self.latency_samples)
        idx = min(int(len(ordered) * 0.95), len(ordered) - 1)
        return ordered[idx]


@dataclass(frozen=True)
class RoutingStats:
    """Point-in-time snapshot of routing state for dashboards."""

    active_url: str
    active_region: str
    failovers_total: int
    nodes: Tuple[Dict[str, Any], ...]


# ---------------------------------------------------------------------------
# Load balancer
# ---------------------------------------------------------------------------


class MultiRegionLoadBalancer:
    """Multi-region RPC load balancer with latency-based routing.

    Maintains a per-node health model from periodic latency probes and real
    request outcomes, then routes every request to the nearest healthy node.
    When the active node degrades, routing shifts dynamically to the next
    best region and a failover counter is incremented.
    """

    def __init__(
        self,
        endpoints: List[NodeEndpoint],
        *,
        health_check_interval_s: float = DEFAULT_HEALTH_CHECK_INTERVAL_S,
        health_threshold: float = DEFAULT_HEALTH_THRESHOLD,
        latency_threshold_ms: float = DEFAULT_LATENCY_THRESHOLD_MS,
        success_rate_threshold: float = DEFAULT_SUCCESS_RATE_THRESHOLD,
        probe_timeout_s: float = DEFAULT_PROBE_TIMEOUT_S,
        routing_hysteresis_factor: float = DEFAULT_ROUTING_HYSTERESIS_FACTOR,
        on_failover: Optional[Any] = None,
    ) -> None:
        if not endpoints:
            raise ValueError("MultiRegionLoadBalancer requires at least one endpoint")
        urls = [ep.url for ep in endpoints]
        if len(urls) != len(set(urls)):
            raise ValueError("Duplicate endpoint URLs are not allowed")

        self.endpoints = list(endpoints)
        self.health_check_interval_s = health_check_interval_s
        self.health_threshold = health_threshold
        self.latency_threshold_ms = latency_threshold_ms
        self.success_rate_threshold = success_rate_threshold
        self.probe_timeout_s = probe_timeout_s
        self.routing_hysteresis_factor = routing_hysteresis_factor
        self.on_failover = on_failover

        self._health: Dict[str, NodeHealth] = {
            ep.url: NodeHealth(endpoint=ep, is_healthy=False) for ep in self.endpoints
        }
        self._active_url: str = self.endpoints[0].url
        self._failovers_total: int = 0
        self._lock = threading.RLock()
        self._monitoring_active = False
        self._monitor_thread: Optional[threading.Thread] = None
        self._in_reevaluate = False
        self._recently_demoted: Dict[str, datetime] = {}
        self._demotion_cooldown_s: float = 60.0

        logger.info(
            "[MultiRegionLB] Initialized | nodes=%d | regions=%s | interval=%.1fs",
            len(self.endpoints),
            sorted({ep.region for ep in self.endpoints}),
            health_check_interval_s,
        )

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start_monitoring(self) -> None:
        """Start the background latency-probe loop."""
        with self._lock:
            if self._monitoring_active:
                logger.warning("[MultiRegionLB] Monitoring already active")
                return
            self._monitoring_active = True
            self._monitor_thread = threading.Thread(
                target=self._monitor_loop,
                daemon=True,
                name="MultiRegionLB",
            )
            self._monitor_thread.start()
            logger.info("[MultiRegionLB] Background monitoring started")

    def stop_monitoring(self) -> None:
        """Stop the background latency-probe loop."""
        with self._lock:
            if not self._monitoring_active:
                return
            self._monitoring_active = False
            thread = self._monitor_thread
        if thread:
            thread.join(timeout=self.probe_timeout_s + 3.0)
        logger.info("[MultiRegionLB] Background monitoring stopped")

    def _monitor_loop(self) -> None:
        while self._monitoring_active:
            try:
                self.run_health_checks()
            except Exception as exc:  # pragma: no cover - defensive
                logger.error("[MultiRegionLB] Health check loop error: %s", exc)
            time.sleep(self.health_check_interval_s)

    # ------------------------------------------------------------------
    # Health checks (latency-based, across all regions)
    # ------------------------------------------------------------------

    def run_health_checks(self) -> None:
        """Probe every node once, re-score, and re-evaluate routing."""
        for ep in self.endpoints:
            success, latency_ms, error = self._probe_node(ep.url)
            self._record_probe(ep.url, success, latency_ms, error)
        self._recompute_scores()
        self._reevaluate_routing()

    def _probe_node(self, url: str) -> Tuple[bool, float, Optional[str]]:
        """Perform a lightweight latency probe against *url*."""
        start = time.time()
        try:
            response = requests.get(
                url,
                timeout=self.probe_timeout_s,
                headers={"Accept": "application/json"},
            )
            latency_ms = (time.time() - start) * 1000
            if response.status_code < 500:
                return True, latency_ms, None
            return False, latency_ms, f"HTTP {response.status_code}"
        except requests.exceptions.Timeout:
            return False, self.probe_timeout_s * 1000, "Timeout"
        except Exception as exc:  # pragma: no cover - network dependent
            return False, (time.time() - start) * 1000, str(exc)

    def _record_probe(
        self,
        url: str,
        success: bool,
        latency_ms: float,
        error: Optional[str],
    ) -> None:
        with self._lock:
            health = self._health[url]
            health.last_check_time = datetime.now(timezone.utc)
            if success:
                health.success_count += 1
                health.consecutive_failures = 0
                health.last_success_time = health.last_check_time
                health.latency_samples.append(latency_ms)
            else:
                health.failure_count += 1
                health.consecutive_failures += 1
                error_key = error or "unknown"
                health.error_types[error_key] = (
                    health.error_types.get(error_key, 0) + 1
                )
            self._apply_health_flags(health)

    def record_request_result(
        self, url: str, success: bool, latency_ms: float
    ) -> None:
        """Fold a real RPC request outcome into the health model."""
        self._record_probe(url, success, latency_ms, None if success else "request_error")
        self._recompute_scores()
        self._reevaluate_routing()

    # ------------------------------------------------------------------
    # Scoring and routing
    # ------------------------------------------------------------------

    def _apply_health_flags(self, health: NodeHealth) -> None:
        if health.consecutive_failures >= FAILURE_THRESHOLD_FOR_UNHEALTHY:
            health.is_healthy = False
            health.health_score = min(health.health_score, 0.0)

    def _recompute_scores(self) -> None:
        """Recalculate health scores from latency and success-rate data."""
        with self._lock:
            for health in self._health.values():
                score = self._calculate_health_score(health)
                health.health_score = score
                if (
                    health.consecutive_failures < FAILURE_THRESHOLD_FOR_UNHEALTHY
                    and health.total_requests > 0
                ):
                    health.is_healthy = (
                        score >= self.health_threshold
                        and health.success_rate >= self.success_rate_threshold
                    )

    def _calculate_health_score(self, health: NodeHealth) -> float:
        # Latency component (40%): full marks under threshold, linear decay.
        avg = health.avg_latency_ms
        if avg == 0.0:
            latency_score = 100.0
        elif avg <= self.latency_threshold_ms:
            latency_score = 100.0
        else:
            latency_score = max(
                0.0, 100.0 - (avg - self.latency_threshold_ms) / 10.0
            )
        # Success-rate component (40%).
        rate = health.success_rate
        if rate >= self.success_rate_threshold:
            success_score = 100.0
        else:
            success_score = max(0.0, (rate / self.success_rate_threshold) * 100.0)
        # Consecutive-failure component (20%).
        penalty = min(100.0, health.consecutive_failures * 20.0)
        return latency_score * 0.4 + success_score * 0.4 + (100.0 - penalty) * 0.2

    def _reevaluate_routing(self) -> None:
        """Move traffic away from the active node when it is degraded or beaten."""
        with self._lock:
            if self._in_reevaluate:
                return
            self._in_reevaluate = True
            try:
                self._reevaluate_routing_locked()
            finally:
                self._in_reevaluate = False

    def _reevaluate_routing_locked(self) -> None:
        active = self._health[self._active_url]

        if active.total_requests == 0:
            # Active node is unproven (e.g. recent failover target). Keep it
            # unless a measured, healthy node decisively beats it.
            candidate = self._select_candidate(exclude=self._active_url)
            if candidate and self._beats_hysteresis(candidate, active):
                self._switch_active(candidate.endpoint.url, "faster_node")
            return

        if active.is_healthy and active.health_score >= self.health_threshold:
            # Healthy: only switch when a node is decisively faster.
            candidate = self._select_candidate(exclude=self._active_url)
            if candidate and self._beats_hysteresis(candidate, active):
                self._switch_active(candidate.endpoint.url, "faster_node")
            return

        candidate = self._select_failover_candidate(exclude=self._active_url)
        if candidate is None:
            logger.error(
                "[MultiRegionLB] No healthy node available; keeping %s",
                self._active_url,
            )
            return
        self._switch_active(candidate.endpoint.url, "degraded_active")

    def _select_failover_candidate(
        self, exclude: Optional[str]
    ) -> Optional[NodeHealth]:
        """Pick a failover target when the active node is degraded.

        Prefers proven-healthy nodes; if none exist, falls back to unproven
        nodes (never probed, no recorded failures) rather than staying on a
        dying endpoint.
        """
        with self._lock:
            proven = self._select_candidate(exclude=exclude)
            if proven is not None:
                return proven
            unproven = [
                h
                for url, h in self._health.items()
                if url != exclude
                and h.total_requests == 0
                and h.consecutive_failures == 0
            ]
            return unproven[0] if unproven else None

    def _get_all_failover_candidates(
        self, exclude: Optional[str]
    ) -> List[NodeHealth]:
        """Return all candidate nodes for failover, sorted best-first.

        Includes proven-healthy, unproven, and recently-demoted nodes
        (with demoted nodes last). Used only when no proven-healthy
        candidate exists.
        """
        with self._lock:
            result: List[NodeHealth] = []
            for url, h in self._health.items():
                if url == exclude:
                    continue
                if h.total_requests == 0 and h.consecutive_failures == 0:
                    result.append(h)
            return result

    def _select_candidate(self, exclude: Optional[str]) -> Optional[NodeHealth]:
        """Return the best healthy, measured node (health desc, latency asc).

        Nodes that have not yet produced a latency sample or were recently
        demoted (cooldown) are excluded so we never hop onto an unmeasured
        endpoint or create a ping-pong failover loop.
        """
        with self._lock:
            pool = [
                h
                for url, h in self._health.items()
                if url != exclude
                and h.is_healthy
                and h.latency_samples
                and url not in self._recently_demoted
            ]
            if not pool:
                return None
            pool.sort(key=lambda h: (-h.health_score, h.avg_latency_ms))
            return pool[0]

    def _beats_hysteresis(
        self, candidate: NodeHealth, active: NodeHealth
    ) -> bool:
        if active.avg_latency_ms <= 0.0 or candidate.avg_latency_ms <= 0.0:
            return False
        return (
            candidate.avg_latency_ms
            < active.avg_latency_ms * self.routing_hysteresis_factor
        )

    def _switch_active(self, new_url: str, reason: str) -> None:
        old_url = self._active_url
        if new_url == old_url:
            return
        self._active_url = new_url
        self._failovers_total += 1
        now = datetime.now(timezone.utc)
        self._recently_demoted[old_url] = now
        # Drop cooldown entries that have expired.
        cutoff = now.timestamp() - self._demotion_cooldown_s
        self._recently_demoted = {
            url: ts
            for url, ts in self._recently_demoted.items()
            if ts.timestamp() >= cutoff
        }
        old = self._health[old_url]
        new = self._health[new_url]
        logger.warning(
            "[MultiRegionLB] ROUTE CHANGE | reason=%s | old=%s(%s, score=%.1f) "
            "| new=%s(%s, score=%.1f) | failovers=%d",
            reason,
            old_url,
            old.endpoint.region,
            old.health_score,
            new_url,
            new.endpoint.region,
            new.health_score,
            self._failovers_total,
        )
        if self.on_failover:
            self.on_failover(old_url, new_url, reason)

    # ------------------------------------------------------------------
    # Request routing
    # ------------------------------------------------------------------

    def get_current_endpoint(self) -> str:
        """Return the currently routed endpoint URL."""
        with self._lock:
            return self._active_url

    def get_current_region(self) -> str:
        """Return the region of the currently routed endpoint."""
        with self._lock:
            return self._health[self._active_url].endpoint.region

    def route(
        self,
        path: str,
        payload: Dict[str, Any],
        *,
        timeout: float = 3.5,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """POST *payload* to the nearest healthy node, failing over on error.

        Candidate order: active node first, then all other nodes ordered by
        health score and latency. Every attempt is recorded so routing
        latency stats stay current.
        """
        with self._lock:
            active = self._active_url
            others = [
                url
                for url, h in sorted(
                    self._health.items(),
                    key=lambda item: (-item[1].health_score, item[1].avg_latency_ms),
                )
                if url != active
            ]
            candidates = [active] + others

        last_error: Optional[Exception] = None
        for url in candidates:
            target = f"{url.rstrip('/')}/{path.lstrip('/')}"
            start = time.time()
            try:
                response = requests.post(
                    target,
                    json=payload,
                    timeout=timeout,
                    headers=headers,
                )
                response.raise_for_status()
                latency_ms = (time.time() - start) * 1000
                self.record_request_result(url, True, latency_ms)
                return response.json()
            except requests.exceptions.Timeout:
                self.record_request_result(url, False, timeout * 1000)
                last_error = requests.exceptions.Timeout(
                    f"{target} timed out after {timeout}s"
                )
                logger.warning(
                    "[MultiRegionLB] Node timed out | url=%s | latency=%.1fms",
                    target,
                    timeout * 1000,
                )
            except requests.exceptions.RequestException as exc:
                latency_ms = (time.time() - start) * 1000
                self.record_request_result(url, False, latency_ms)
                last_error = exc
                logger.warning(
                    "[MultiRegionLB] Node failed | url=%s | error=%s",
                    target,
                    exc,
                )

        raise ConnectionError(
            f"All {len(candidates)} RPC endpoints failed to respond"
        ) from last_error

    # ------------------------------------------------------------------
    # Stats export (Grafana / Prometheus)
    # ------------------------------------------------------------------

    def get_routing_stats(self) -> RoutingStats:
        """Snapshot of routing state for dashboards and tests."""
        with self._lock:
            active = self._health[self._active_url]
            nodes = []
            for url, health in self._health.items():
                nodes.append(
                    {
                        "url": url,
                        "region": health.endpoint.region,
                        "health_score": round(health.health_score, 2),
                        "is_healthy": health.is_healthy,
                        "avg_latency_ms": round(health.avg_latency_ms, 2),
                        "p95_latency_ms": round(health.p95_latency_ms, 2),
                        "success_rate": round(health.success_rate, 4),
                        "consecutive_failures": health.consecutive_failures,
                        "total_requests": health.total_requests,
                    }
                )
            return RoutingStats(
                active_url=active.endpoint.url,
                active_region=active.endpoint.region,
                failovers_total=self._failovers_total,
                nodes=tuple(nodes),
            )

    def export_prometheus(self) -> str:
        """Render routing latency stats in Prometheus exposition format.

        Serve the returned text from a ``/metrics`` endpoint so a Prometheus
        instance can scrape it and Grafana dashboards can graph per-region
        routing latency, node health, request outcomes, and failovers.
        """
        stats = self.get_routing_stats()
        lines: List[str] = []

        lines.append(
            "# HELP stellarflow_rpc_routing_latency_ms "
            "Average routing latency per RPC node in milliseconds."
        )
        lines.append("# TYPE stellarflow_rpc_routing_latency_ms gauge")
        for node in stats.nodes:
            lines.append(
                'stellarflow_rpc_routing_latency_ms'
                f'{{region="{node["region"]}",url="{node["url"]}"}}'
                f" {node['avg_latency_ms']}"
            )

        lines.append(
            "# HELP stellarflow_rpc_node_health_score "
            "Composite health score (0-100) per RPC node."
        )
        lines.append("# TYPE stellarflow_rpc_node_health_score gauge")
        for node in stats.nodes:
            lines.append(
                'stellarflow_rpc_node_health_score'
                f'{{region="{node["region"]}",url="{node["url"]}"}}'
                f" {node['health_score']}"
            )

        lines.append(
            "# HELP stellarflow_rpc_node_healthy "
            "Whether the node is considered healthy (1) or not (0)."
        )
        lines.append("# TYPE stellarflow_rpc_node_healthy gauge")
        for node in stats.nodes:
            lines.append(
                'stellarflow_rpc_node_healthy'
                f'{{region="{node["region"]}",url="{node["url"]}"}}'
                f" {1 if node['is_healthy'] else 0}"
            )

        lines.append(
            "# HELP stellarflow_rpc_failovers_total "
            "Total number of routing failovers since process start."
        )
        lines.append("# TYPE stellarflow_rpc_failovers_total counter")
        lines.append(f"stellarflow_rpc_failovers_total {stats.failovers_total}")

        lines.append(
            "# HELP stellarflow_rpc_active_endpoint_info "
            "Currently active routing target; value is always 1."
        )
        lines.append("# TYPE stellarflow_rpc_active_endpoint_info gauge")
        lines.append(
            'stellarflow_rpc_active_endpoint_info'
            f'{{region="{stats.active_region}",url="{stats.active_url}"}} 1'
        )

        return "\n".join(lines) + "\n"


__all__ = [
    "MultiRegionLoadBalancer",
    "NodeEndpoint",
    "NodeHealth",
    "RoutingStats",
    "DEFAULT_HEALTH_CHECK_INTERVAL_S",
    "DEFAULT_HEALTH_THRESHOLD",
    "DEFAULT_LATENCY_THRESHOLD_MS",
    "DEFAULT_SUCCESS_RATE_THRESHOLD",
    "DEFAULT_PROBE_TIMEOUT_S",
    "DEFAULT_ROUTING_HYSTERESIS_FACTOR",
]
