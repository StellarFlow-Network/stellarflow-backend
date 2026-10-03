"""FastAPI router for Fiat Settlement Latency Monitoring and Anchor Failover."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

try:
    from fastapi import APIRouter, HTTPException, Query
    from pydantic import BaseModel, Field
except ImportError:
    class APIRouter:  # type: ignore
        def __init__(self, *args, **kwargs): pass
        def get(self, *args, **kwargs): return lambda f: f
        def post(self, *args, **kwargs): return lambda f: f

    class HTTPException(Exception):  # type: ignore
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = status_code

    class BaseModel:  # type: ignore
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)

    def Query(default=None, **kwargs): return default  # type: ignore
    def Field(default=None, **kwargs): return default  # type: ignore


from src.analytics.fiat_settlement import (
    Corridor,
    DEFAULT_SLA_THRESHOLD_SECONDS,
    FiatSettlementLatencyMonitor,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settlement", tags=["Fiat Settlement Latency Monitoring"])

# Shared singleton monitor for application-level state
_global_monitor = FiatSettlementLatencyMonitor()


def get_settlement_monitor() -> FiatSettlementLatencyMonitor:
    return _global_monitor


class AnchorMetricsDTO(BaseModel):
    anchor_id: str
    corridor: str
    sample_count: int
    mean_settlement_seconds: float
    mean_settlement_hours: float
    median_settlement_seconds: float
    min_settlement_seconds: float
    max_settlement_seconds: float
    p95_settlement_seconds: float
    std_dev_seconds: float
    sla_threshold_seconds: float
    sla_threshold_hours: float
    is_sla_violated: bool
    status: str
    deactivated_at: Optional[str] = None
    deactivation_reason: Optional[str] = None
    pending_transaction_count: int = 0
    evaluated_at: str


class CorridorMetricsDTO(BaseModel):
    corridor: str
    sender_currency: str
    receiver_currency: str
    mean_settlement_seconds: float
    mean_settlement_hours: float
    total_completed: int
    total_pending: int
    active_anchors: List[str]
    deactivated_anchors: List[str]
    anchor_metrics: Dict[str, AnchorMetricsDTO]
    evaluated_at: str


class EvaluateResponseDTO(BaseModel):
    evaluated_anchors: int
    violations_detected: int
    deactivated_records: List[Dict[str, Any]]
    audit_log_count: int


@router.get("/corridors", response_model=List[Dict[str, Any]])
async def list_corridors() -> List[Dict[str, Any]]:
    """Lists summary settlement metrics for all known corridors."""
    monitor = get_settlement_monitor()
    corridors = set(monitor._registered_partners.keys())
    for r in monitor._records.values():
        corridors.add(r.corridor.key)

    results: List[Dict[str, Any]] = []
    for c_key in sorted(corridors):
        metrics = monitor.get_corridor_metrics(c_key)
        results.append(metrics.to_dict())
    return results


@router.get("/corridors/{sender}/{receiver}", response_model=Dict[str, Any])
async def get_corridor_metrics(
    sender: str,
    receiver: str,
    window_seconds: Optional[float] = Query(None, description="Rolling time window in seconds"),
) -> Dict[str, Any]:
    """Gets settlement latency metrics for a specific corridor (e.g. USD -> NGN)."""
    monitor = get_settlement_monitor()
    try:
        corridor = Corridor.from_pair(sender, receiver)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    metrics = monitor.get_corridor_metrics(corridor, window_seconds=window_seconds)
    return metrics.to_dict()


@router.post("/evaluate", response_model=EvaluateResponseDTO)
async def evaluate_sla(
    corridor: Optional[str] = Query(None, description="Optional corridor filter (e.g. 'USD -> NGN')"),
) -> EvaluateResponseDTO:
    """Evaluates all anchors against the T_settlement > 4 hours SLA threshold.

    Automatically deactivates underperforming anchors and re-routes pending remittances
    to backup corridor partners.
    """
    monitor = get_settlement_monitor()
    report = monitor.evaluate_all_anchors(corridor=corridor)
    return EvaluateResponseDTO(
        evaluated_anchors=report["evaluated_anchors"],
        violations_detected=report["violations_detected"],
        deactivated_records=report["deactivated_records"],
        audit_log_count=report["audit_log_count"],
    )


@router.get("/audit", response_model=Dict[str, Any])
async def get_audit_trail() -> Dict[str, Any]:
    """Retrieves the audit log of all anchor deactivations and remittance re-routing reports."""
    monitor = get_settlement_monitor()
    return {
        "audit_records": [a.to_dict() for a in monitor.get_audit_records()],
        "reroute_reports": [r.to_dict() for r in monitor.get_reroute_reports()],
    }
