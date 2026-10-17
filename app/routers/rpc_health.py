"""REST router for Soroban RPC node health and latency matrix.

Issue #1294 — Build Soroban RPC Node Latency & Health Matrix Exporter

Exposes two endpoints:

GET /api/v1/rpc/nodes/health
    Full health matrix — one entry per configured node, including latency
    percentiles, ledger sequence, lag, error counts, and health status.
    Used by the load balancer and operator dashboards.

GET /api/v1/rpc/nodes/status
    Lightweight summary: total node count, healthy count, best ledger
    tip, and the list of healthy node URLs. Designed for quick liveness
    checks from the load balancer routing layer.
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

import structlog
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.workers.soroban_rpc_health import NodeHealthSnapshot, get_health_matrix

log = structlog.get_logger(__name__)

router = APIRouter(tags=["RPC Health"])


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class NodeHealthResponse(BaseModel):
    """Per-node health snapshot returned by GET /api/v1/rpc/nodes/health."""

    node_url: str
    is_healthy: bool
    latency_ms: float
    avg_latency_ms: float
    p95_latency_ms: float
    ledger_sequence: Optional[int]
    ledger_lag: int
    error_count: int
    consecutive_failures: int
    rpc_status: Optional[str]
    last_check_at: Optional[datetime]
    last_success_at: Optional[datetime]


class HealthMatrixResponse(BaseModel):
    """Full matrix response from GET /api/v1/rpc/nodes/health."""

    total_nodes: int
    healthy_nodes: int
    degraded_nodes: int
    best_ledger_sequence: Optional[int]
    nodes: List[NodeHealthResponse]


class NodeStatusResponse(BaseModel):
    """Lightweight status summary from GET /api/v1/rpc/nodes/status."""

    total_nodes: int
    healthy_nodes: int
    healthy_node_urls: List[str]
    best_ledger_sequence: Optional[int]
    all_healthy: bool


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _snapshot_to_response(s: NodeHealthSnapshot) -> NodeHealthResponse:
    return NodeHealthResponse(
        node_url=s.node_url,
        is_healthy=s.is_healthy,
        latency_ms=round(s.latency_ms, 2),
        avg_latency_ms=round(s.avg_latency_ms, 2),
        p95_latency_ms=round(s.p95_latency_ms, 2),
        ledger_sequence=s.ledger_sequence,
        ledger_lag=s.ledger_lag,
        error_count=s.error_count,
        consecutive_failures=s.consecutive_failures,
        rpc_status=s.rpc_status,
        last_check_at=s.last_check_at,
        last_success_at=s.last_success_at,
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get(
    "/rpc/nodes/health",
    response_model=HealthMatrixResponse,
    summary="Full Soroban RPC node health matrix",
    description=(
        "Returns latency percentiles, ledger sequence heights, ledger lag, "
        "and error counts for every configured Soroban RPC node. "
        "Use this endpoint to drive dynamic load-balancer routing decisions."
    ),
)
async def get_rpc_health_matrix() -> HealthMatrixResponse:
    """Return the full health matrix for all configured Soroban RPC nodes."""
    try:
        matrix = get_health_matrix()
        snapshots = matrix.get_all_snapshots()
    except Exception as exc:
        log.exception("rpc_health.matrix_fetch_failed", error=str(exc))
        raise HTTPException(status_code=503, detail="RPC health matrix unavailable") from exc

    node_responses = [_snapshot_to_response(s) for s in snapshots]
    healthy_count = sum(1 for s in snapshots if s.is_healthy)
    best_ledger = max(
        (s.ledger_sequence for s in snapshots if s.ledger_sequence is not None),
        default=None,
    )

    log.info(
        "rpc_health.matrix_fetched",
        total=len(snapshots),
        healthy=healthy_count,
        best_ledger=best_ledger,
    )

    return HealthMatrixResponse(
        total_nodes=len(snapshots),
        healthy_nodes=healthy_count,
        degraded_nodes=len(snapshots) - healthy_count,
        best_ledger_sequence=best_ledger,
        nodes=node_responses,
    )


@router.get(
    "/rpc/nodes/status",
    response_model=NodeStatusResponse,
    summary="Lightweight Soroban RPC node status summary",
    description=(
        "Returns a compact summary of healthy vs. total node counts and the "
        "list of healthy node URLs. Designed for load-balancer health probes "
        "and automated routing decisions."
    ),
)
async def get_rpc_node_status() -> NodeStatusResponse:
    """Return a lightweight health summary for the Soroban RPC node pool."""
    try:
        matrix = get_health_matrix()
        snapshots = matrix.get_all_snapshots()
        healthy_urls = matrix.get_healthy_nodes()
    except Exception as exc:
        log.exception("rpc_health.status_fetch_failed", error=str(exc))
        raise HTTPException(status_code=503, detail="RPC node status unavailable") from exc

    best_ledger = max(
        (s.ledger_sequence for s in snapshots if s.ledger_sequence is not None),
        default=None,
    )

    return NodeStatusResponse(
        total_nodes=len(snapshots),
        healthy_nodes=len(healthy_urls),
        healthy_node_urls=healthy_urls,
        best_ledger_sequence=best_ledger,
        all_healthy=len(healthy_urls) == len(snapshots) and len(snapshots) > 0,
    )
