"""Fiat Settlement Latency Monitoring and Automated Anchor Failover Service.

Monitors fiat settlement latency across regional payout anchors to guarantee delivery times.
Deliverables:
1. Track mean time to settlement T_settlement per corridor (e.g., USD -> NGN, EUR -> KES).
2. Deactivate underperforming anchors automatically if T_settlement > 4 hours (14,400 seconds).
3. Re-route pending remittance traffic to backup corridor partners.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from enum import Enum
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union

logger = logging.getLogger(__name__)

# Default SLA threshold: 4 hours = 14,400 seconds
DEFAULT_SLA_THRESHOLD_SECONDS: float = 4.0 * 3600.0  # 14,400.0s


class AnchorHealthStatus(str, Enum):
    """Health and activation status for payout anchors within a corridor."""
    ACTIVE = "ACTIVE"
    DEGRADED = "DEGRADED"
    DEACTIVATED = "DEACTIVATED"
    SLA_BREACHED = "SLA_BREACHED"


@dataclass(frozen=True)
class Corridor:
    """Represents a fiat remittance corridor (e.g. USD -> NGN, EUR -> KES)."""
    sender_currency: str
    receiver_currency: str

    @classmethod
    def from_pair(cls, sender: str, receiver: str) -> Corridor:
        return cls(
            sender_currency=sender.strip().upper(),
            receiver_currency=receiver.strip().upper(),
        )

    @classmethod
    def parse(cls, corridor_str: str) -> Corridor:
        """Parses strings like 'USD -> NGN', 'USD->NGN', or 'USD-NGN'."""
        delimiter = "->" if "->" in corridor_str else "-"
        parts = corridor_str.split(delimiter)
        if len(parts) != 2:
            raise ValueError(f"Invalid corridor format: '{corridor_str}'. Expected 'SENDER -> RECEIVER'")
        return cls.from_pair(parts[0], parts[1])

    @property
    def key(self) -> str:
        """Standard human-readable corridor representation."""
        return f"{self.sender_currency} -> {self.receiver_currency}"

    def __str__(self) -> str:
        return self.key


@dataclass
class SettlementRecord:
    """Represents a remittance settlement transaction lifecycle record."""
    transaction_id: str
    corridor: Corridor
    anchor_id: str
    amount: float
    dispatched_at: datetime
    settled_at: Optional[datetime] = None
    status: str = "PENDING"
    priority: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def is_settled(self) -> bool:
        return self.settled_at is not None and self.status in {
            "COMPLETED",
            "SETTLED",
            "SUCCESS",
            "DELIVERED",
        }

    @property
    def duration_seconds(self) -> Optional[float]:
        """Settlement latency Delta t = t_settled - t_dispatched in seconds."""
        if self.settled_at is None:
            return None
        return max(0.0, (self.settled_at - self.dispatched_at).total_seconds())

    @property
    def duration_hours(self) -> Optional[float]:
        """Settlement latency Delta t in hours."""
        sec = self.duration_seconds
        return sec / 3600.0 if sec is not None else None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "transaction_id": self.transaction_id,
            "corridor": self.corridor.key,
            "anchor_id": self.anchor_id,
            "amount": self.amount,
            "dispatched_at": self.dispatched_at.isoformat(),
            "settled_at": self.settled_at.isoformat() if self.settled_at else None,
            "status": self.status,
            "duration_seconds": self.duration_seconds,
            "duration_hours": self.duration_hours,
            "metadata": self.metadata,
        }


@dataclass
class AnchorCorridorMetrics:
    """Settlement latency metrics for an anchor operating within a specific corridor."""
    anchor_id: str
    corridor: str
    sample_count: int
    mean_settlement_seconds: float  # T_settlement in seconds
    mean_settlement_hours: float    # T_settlement in hours
    median_settlement_seconds: float
    min_settlement_seconds: float
    max_settlement_seconds: float
    p95_settlement_seconds: float
    std_dev_seconds: float
    sla_threshold_seconds: float
    sla_threshold_hours: float
    is_sla_violated: bool
    status: AnchorHealthStatus
    deactivated_at: Optional[datetime] = None
    deactivation_reason: Optional[str] = None
    pending_transaction_count: int = 0
    evaluated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "anchor_id": self.anchor_id,
            "corridor": self.corridor,
            "sample_count": self.sample_count,
            "mean_settlement_seconds": round(self.mean_settlement_seconds, 2),
            "mean_settlement_hours": round(self.mean_settlement_hours, 4),
            "median_settlement_seconds": round(self.median_settlement_seconds, 2),
            "min_settlement_seconds": round(self.min_settlement_seconds, 2),
            "max_settlement_seconds": round(self.max_settlement_seconds, 2),
            "p95_settlement_seconds": round(self.p95_settlement_seconds, 2),
            "std_dev_seconds": round(self.std_dev_seconds, 2),
            "sla_threshold_seconds": self.sla_threshold_seconds,
            "sla_threshold_hours": self.sla_threshold_hours,
            "is_sla_violated": self.is_sla_violated,
            "status": self.status.value if isinstance(self.status, Enum) else self.status,
            "deactivated_at": self.deactivated_at.isoformat() if self.deactivated_at else None,
            "deactivation_reason": self.deactivation_reason,
            "pending_transaction_count": self.pending_transaction_count,
            "evaluated_at": self.evaluated_at.isoformat(),
        }


@dataclass
class CorridorSettlementMetrics:
    """Overall settlement latency metrics for an entire corridor."""
    corridor: str
    sender_currency: str
    receiver_currency: str
    mean_settlement_seconds: float
    mean_settlement_hours: float
    total_completed: int
    total_pending: int
    active_anchors: List[str]
    deactivated_anchors: List[str]
    anchor_metrics: Dict[str, AnchorCorridorMetrics]
    evaluated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "corridor": self.corridor,
            "sender_currency": self.sender_currency,
            "receiver_currency": self.receiver_currency,
            "mean_settlement_seconds": round(self.mean_settlement_seconds, 2),
            "mean_settlement_hours": round(self.mean_settlement_hours, 4),
            "total_completed": self.total_completed,
            "total_pending": self.total_pending,
            "active_anchors": self.active_anchors,
            "deactivated_anchors": self.deactivated_anchors,
            "anchor_metrics": {k: v.to_dict() for k, v in self.anchor_metrics.items()},
            "evaluated_at": self.evaluated_at.isoformat(),
        }


@dataclass
class BackupPartnerCandidate:
    """Candidate backup anchor partner for corridor remittance failover."""
    anchor_id: str
    corridor: str
    priority: int = 0
    mean_settlement_seconds: float = 0.0
    fee: float = 0.0
    rate: float = 1.0
    target_rail: str = "DEFAULT"
    status: AnchorHealthStatus = AnchorHealthStatus.ACTIVE


@dataclass
class RerouteResult:
    """Result of re-routing an individual pending remittance transaction."""
    transaction_id: str
    corridor: str
    previous_anchor_id: str
    new_anchor_id: Optional[str]
    success: bool
    reason: str
    rerouted_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "transaction_id": self.transaction_id,
            "corridor": self.corridor,
            "previous_anchor_id": self.previous_anchor_id,
            "new_anchor_id": self.new_anchor_id,
            "success": self.success,
            "reason": self.reason,
            "rerouted_at": self.rerouted_at.isoformat(),
        }


@dataclass
class RerouteBatchReport:
    """Summary of re-routing all pending remittance traffic from a deactivated anchor."""
    corridor: str
    deactivated_anchor_id: str
    total_pending: int
    rerouted_count: int
    unroutable_count: int
    backup_partner_assigned: Optional[str]
    results: List[RerouteResult] = field(default_factory=list)
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "corridor": self.corridor,
            "deactivated_anchor_id": self.deactivated_anchor_id,
            "total_pending": self.total_pending,
            "rerouted_count": self.rerouted_count,
            "unroutable_count": self.unroutable_count,
            "backup_partner_assigned": self.backup_partner_assigned,
            "results": [r.to_dict() for r in self.results],
            "timestamp": self.timestamp.isoformat(),
        }


@dataclass
class SLABreachAuditRecord:
    """Audit log entry for an anchor SLA breach and subsequent deactivation."""
    anchor_id: str
    corridor: str
    measured_t_settlement_seconds: float
    measured_t_settlement_hours: float
    threshold_seconds: float
    threshold_hours: float
    sample_count: int
    deactivated_at: datetime
    reason: str
    reroute_report: Optional[RerouteBatchReport] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "anchor_id": self.anchor_id,
            "corridor": self.corridor,
            "measured_t_settlement_seconds": round(self.measured_t_settlement_seconds, 2),
            "measured_t_settlement_hours": round(self.measured_t_settlement_hours, 4),
            "threshold_seconds": self.threshold_seconds,
            "threshold_hours": self.threshold_hours,
            "sample_count": self.sample_count,
            "deactivated_at": self.deactivated_at.isoformat(),
            "reason": self.reason,
            "reroute_report": self.reroute_report.to_dict() if self.reroute_report else None,
        }


# ============================================================================
# Pure Calculation Utilities
# ============================================================================

def calculate_mean_time_to_settlement(durations: Sequence[float]) -> float:
    """Calculates arithmetic mean time to settlement T_settlement = (1/N) * sum(Delta t_i)."""
    if not durations:
        return 0.0
    return sum(durations) / float(len(durations))


def calculate_percentile(sorted_data: Sequence[float], percentile: float) -> float:
    """Calculates the specified percentile (0.0 to 1.0) from pre-sorted data."""
    if not sorted_data:
        return 0.0
    if len(sorted_data) == 1:
        return sorted_data[0]
    idx = (len(sorted_data) - 1) * percentile
    lower = int(math.floor(idx))
    upper = int(math.ceil(idx))
    weight = idx - lower
    return sorted_data[lower] * (1.0 - weight) + sorted_data[upper] * weight


def is_sla_violated(
    t_settlement_seconds: float,
    threshold_seconds: float = DEFAULT_SLA_THRESHOLD_SECONDS,
) -> bool:
    """Checks whether mean settlement latency strictly exceeds SLA threshold (default > 4 hours)."""
    return t_settlement_seconds > threshold_seconds


# ============================================================================
# Main Service: FiatSettlementLatencyMonitor
# ============================================================================

class FiatSettlementLatencyMonitor:
    """Core engine for tracking mean settlement latency, automated anchor deactivation,

    and dynamic remittance re-routing to backup partners.
    """

    def __init__(
        self,
        sla_threshold_seconds: float = DEFAULT_SLA_THRESHOLD_SECONDS,
        min_samples_for_deactivation: int = 1,
        rolling_window_seconds: Optional[float] = None,
    ) -> None:
        self.sla_threshold_seconds = float(sla_threshold_seconds)
        self.min_samples_for_deactivation = max(1, int(min_samples_for_deactivation))
        self.rolling_window_seconds = rolling_window_seconds

        # In-memory stores
        # transaction_id -> SettlementRecord
        self._records: Dict[str, SettlementRecord] = {}

        # (anchor_id, corridor_key) -> AnchorHealthStatus
        self._anchor_statuses: Dict[Tuple[str, str], AnchorHealthStatus] = {}

        # (anchor_id, corridor_key) -> deactivation timestamp
        self._deactivated_at: Dict[Tuple[str, str], datetime] = {}
        self._deactivation_reasons: Dict[Tuple[str, str], str] = {}

        # corridor_key -> List[BackupPartnerCandidate]
        self._registered_partners: Dict[str, Dict[str, BackupPartnerCandidate]] = {}

        # Audit logs
        self._audit_records: List[SLABreachAuditRecord] = []
        self._reroute_reports: List[RerouteBatchReport] = []

    # ------------------------------------------------------------------------
    # Anchor & Route Registration
    # ------------------------------------------------------------------------

    def register_anchor_corridor(
        self,
        anchor_id: str,
        corridor: Union[str, Corridor],
        priority: int = 0,
        fee: float = 0.0,
        rate: float = 1.0,
        target_rail: str = "DEFAULT",
        initial_status: AnchorHealthStatus = AnchorHealthStatus.ACTIVE,
    ) -> None:
        """Registers or updates an anchor payout partner for a specific corridor."""
        c = corridor if isinstance(corridor, Corridor) else Corridor.parse(corridor)
        corridor_key = c.key

        if corridor_key not in self._registered_partners:
            self._registered_partners[corridor_key] = {}

        existing = self._registered_partners[corridor_key].get(anchor_id)
        effective_priority = priority if (priority != 0 or existing is None) else existing.priority
        effective_fee = fee if (fee != 0.0 or existing is None) else existing.fee
        effective_rate = rate if (rate != 1.0 or existing is None) else existing.rate
        effective_rail = target_rail if (target_rail != "DEFAULT" or existing is None) else existing.target_rail

        self._registered_partners[corridor_key][anchor_id] = BackupPartnerCandidate(
            anchor_id=anchor_id,
            corridor=corridor_key,
            priority=effective_priority,
            fee=effective_fee,
            rate=effective_rate,
            target_rail=effective_rail,
            status=initial_status,
        )

        pair_key = (anchor_id, corridor_key)
        if pair_key not in self._anchor_statuses:
            self._anchor_statuses[pair_key] = initial_status

    def set_anchor_status(
        self,
        anchor_id: str,
        corridor: Union[str, Corridor],
        status: AnchorHealthStatus,
        reason: Optional[str] = None,
    ) -> None:
        """Manually sets anchor health status for a corridor."""
        c = corridor if isinstance(corridor, Corridor) else Corridor.parse(corridor)
        corridor_key = c.key
        pair_key = (anchor_id, corridor_key)

        self._anchor_statuses[pair_key] = status
        if status in {AnchorHealthStatus.DEACTIVATED, AnchorHealthStatus.SLA_BREACHED}:
            self._deactivated_at[pair_key] = datetime.now(timezone.utc)
            if reason:
                self._deactivation_reasons[pair_key] = reason
        elif pair_key in self._deactivated_at:
            del self._deactivated_at[pair_key]
            self._deactivation_reasons.pop(pair_key, None)

        # Sync partner candidate status
        if corridor_key in self._registered_partners and anchor_id in self._registered_partners[corridor_key]:
            self._registered_partners[corridor_key][anchor_id].status = status

    def get_anchor_status(self, anchor_id: str, corridor: Union[str, Corridor]) -> AnchorHealthStatus:
        """Returns the current activation status of an anchor in a corridor."""
        c = corridor if isinstance(corridor, Corridor) else Corridor.parse(corridor)
        return self._anchor_statuses.get((anchor_id, c.key), AnchorHealthStatus.ACTIVE)

    # ------------------------------------------------------------------------
    # Transaction Ingestion
    # ------------------------------------------------------------------------

    def record_dispatch(
        self,
        transaction_id: str,
        corridor: Union[str, Corridor],
        anchor_id: str,
        amount: float,
        dispatched_at: Optional[datetime] = None,
        priority: int = 0,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SettlementRecord:
        """Records a new pending remittance dispatched to a regional payout anchor."""
        c = corridor if isinstance(corridor, Corridor) else Corridor.parse(corridor)
        now = dispatched_at or datetime.now(timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)

        record = SettlementRecord(
            transaction_id=transaction_id,
            corridor=c,
            anchor_id=anchor_id,
            amount=amount,
            dispatched_at=now,
            status="PENDING",
            priority=priority,
            metadata=metadata or {},
        )
        self._records[transaction_id] = record

        # Auto-register anchor if not already known
        corridor_partners = self._registered_partners.get(c.key, {})
        if anchor_id not in corridor_partners:
            self.register_anchor_corridor(anchor_id, c, priority=priority)

        return record

    def record_settlement(
        self,
        transaction_id: str,
        settled_at: Optional[datetime] = None,
        status: str = "COMPLETED",
    ) -> Optional[SettlementRecord]:
        """Records the settlement completion of a remittance by the regional anchor."""
        record = self._records.get(transaction_id)
        if record is None:
            logger.warning("Attempted to record settlement for unknown transaction: %s", transaction_id)
            return None

        now = settled_at or datetime.now(timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)

        record.settled_at = now
        record.status = status.upper()
        return record

    # ------------------------------------------------------------------------
    # Metrics & Latency Tracking (Deliverable 1)
    # ------------------------------------------------------------------------

    def _filter_records(
        self,
        corridor_key: Optional[str] = None,
        anchor_id: Optional[str] = None,
        window_seconds: Optional[float] = None,
        settled_only: bool = True,
    ) -> List[SettlementRecord]:
        now = datetime.now(timezone.utc)
        win = window_seconds if window_seconds is not None else self.rolling_window_seconds

        result: List[SettlementRecord] = []
        for r in self._records.values():
            if corridor_key and r.corridor.key != corridor_key:
                continue
            if anchor_id and r.anchor_id != anchor_id:
                continue
            if settled_only and not r.is_settled:
                continue

            if win is not None:
                ref_time = r.settled_at if r.settled_at else r.dispatched_at
                if (now - ref_time).total_seconds() > win:
                    continue

            result.append(r)
        return result

    def calculate_mean_time_to_settlement(
        self,
        corridor: Union[str, Corridor],
        anchor_id: Optional[str] = None,
        window_seconds: Optional[float] = None,
    ) -> float:
        """Calculates mean time to settlement T_settlement (in seconds) for a corridor or anchor."""
        c = corridor if isinstance(corridor, Corridor) else Corridor.parse(corridor)
        records = self._filter_records(
            corridor_key=c.key,
            anchor_id=anchor_id,
            window_seconds=window_seconds,
            settled_only=True,
        )
        durations = [r.duration_seconds for r in records if r.duration_seconds is not None]
        return calculate_mean_time_to_settlement(durations)

    def get_anchor_metrics(
        self,
        anchor_id: str,
        corridor: Union[str, Corridor],
        window_seconds: Optional[float] = None,
    ) -> AnchorCorridorMetrics:
        """Computes comprehensive settlement latency metrics for a specific anchor in a corridor."""
        c = corridor if isinstance(corridor, Corridor) else Corridor.parse(corridor)
        corridor_key = c.key

        settled_records = self._filter_records(
            corridor_key=corridor_key,
            anchor_id=anchor_id,
            window_seconds=window_seconds,
            settled_only=True,
        )
        durations = sorted([r.duration_seconds for r in settled_records if r.duration_seconds is not None])
        sample_count = len(durations)

        mean_sec = calculate_mean_time_to_settlement(durations)
        mean_hours = mean_sec / 3600.0

        if sample_count > 0:
            median_sec = calculate_percentile(durations, 0.5)
            min_sec = durations[0]
            max_sec = durations[-1]
            p95_sec = calculate_percentile(durations, 0.95)
            variance = sum((d - mean_sec) ** 2 for d in durations) / float(sample_count)
            std_dev_sec = math.sqrt(variance)
        else:
            median_sec = 0.0
            min_sec = 0.0
            max_sec = 0.0
            p95_sec = 0.0
            std_dev_sec = 0.0

        pending_records = [
            r for r in self._records.values()
            if r.corridor.key == corridor_key and r.anchor_id == anchor_id and not r.is_settled
        ]

        pair_key = (anchor_id, corridor_key)
        current_status = self._anchor_statuses.get(pair_key, AnchorHealthStatus.ACTIVE)
        violated = (sample_count >= self.min_samples_for_deactivation) and is_sla_violated(
            mean_sec, self.sla_threshold_seconds
        )

        return AnchorCorridorMetrics(
            anchor_id=anchor_id,
            corridor=corridor_key,
            sample_count=sample_count,
            mean_settlement_seconds=mean_sec,
            mean_settlement_hours=mean_hours,
            median_settlement_seconds=median_sec,
            min_settlement_seconds=min_sec,
            max_settlement_seconds=max_sec,
            p95_settlement_seconds=p95_sec,
            std_dev_seconds=std_dev_sec,
            sla_threshold_seconds=self.sla_threshold_seconds,
            sla_threshold_hours=self.sla_threshold_seconds / 3600.0,
            is_sla_violated=violated,
            status=current_status,
            deactivated_at=self._deactivated_at.get(pair_key),
            deactivation_reason=self._deactivation_reasons.get(pair_key),
            pending_transaction_count=len(pending_records),
        )

    def get_corridor_metrics(
        self,
        corridor: Union[str, Corridor],
        window_seconds: Optional[float] = None,
    ) -> CorridorSettlementMetrics:
        """Computes aggregate corridor-wide metrics and individual metrics for all associated anchors."""
        c = corridor if isinstance(corridor, Corridor) else Corridor.parse(corridor)
        corridor_key = c.key

        # Collect all anchors participating in this corridor
        anchors = set()
        if corridor_key in self._registered_partners:
            anchors.update(self._registered_partners[corridor_key].keys())
        for r in self._records.values():
            if r.corridor.key == corridor_key:
                anchors.add(r.anchor_id)

        anchor_metrics_map: Dict[str, AnchorCorridorMetrics] = {}
        active_anchors: List[str] = []
        deactivated_anchors: List[str] = []

        all_settled_records = self._filter_records(
            corridor_key=corridor_key,
            window_seconds=window_seconds,
            settled_only=True,
        )
        all_durations = [r.duration_seconds for r in all_settled_records if r.duration_seconds is not None]
        overall_mean_sec = calculate_mean_time_to_settlement(all_durations)

        for anchor_id in sorted(anchors):
            m = self.get_anchor_metrics(anchor_id, c, window_seconds=window_seconds)
            anchor_metrics_map[anchor_id] = m
            if m.status in {AnchorHealthStatus.DEACTIVATED, AnchorHealthStatus.SLA_BREACHED}:
                deactivated_anchors.append(anchor_id)
            else:
                active_anchors.append(anchor_id)

        pending_total = len([
            r for r in self._records.values()
            if r.corridor.key == corridor_key and not r.is_settled
        ])

        return CorridorSettlementMetrics(
            corridor=corridor_key,
            sender_currency=c.sender_currency,
            receiver_currency=c.receiver_currency,
            mean_settlement_seconds=overall_mean_sec,
            mean_settlement_hours=overall_mean_sec / 3600.0,
            total_completed=len(all_settled_records),
            total_pending=pending_total,
            active_anchors=active_anchors,
            deactivated_anchors=deactivated_anchors,
            anchor_metrics=anchor_metrics_map,
        )

    # ------------------------------------------------------------------------
    # Automated Deactivation & Re-routing (Deliverables 2 & 3)
    # ------------------------------------------------------------------------

    def find_backup_partner(
        self,
        corridor: Union[str, Corridor],
        excluded_anchor_id: str,
    ) -> Optional[BackupPartnerCandidate]:
        """Finds the optimal active backup partner for a corridor.

        Ranking criterion:
        1. Higher route priority first.
        2. Lowest historical mean settlement latency T_settlement.
        3. Lowest fee / best exchange rate.
        """
        c = corridor if isinstance(corridor, Corridor) else Corridor.parse(corridor)
        corridor_key = c.key

        candidates: List[BackupPartnerCandidate] = []
        registered = self._registered_partners.get(corridor_key, {})

        for anchor_id, candidate in registered.items():
            if anchor_id == excluded_anchor_id:
                continue
            status = self.get_anchor_status(anchor_id, c)
            if status != AnchorHealthStatus.ACTIVE:
                continue

            # Update latency metric for candidate
            latency = self.calculate_mean_time_to_settlement(c, anchor_id=anchor_id)
            candidates.append(
                BackupPartnerCandidate(
                    anchor_id=anchor_id,
                    corridor=corridor_key,
                    priority=candidate.priority,
                    mean_settlement_seconds=latency,
                    fee=candidate.fee,
                    rate=candidate.rate,
                    target_rail=candidate.target_rail,
                    status=status,
                )
            )

        if not candidates:
            return None

        # Sort: priority (desc), latency (asc, 0-latency unranked candidates placed reasonably), fee (asc)
        def sort_key(cand: BackupPartnerCandidate):
            lat = cand.mean_settlement_seconds if cand.mean_settlement_seconds > 0 else 999999.0
            return (-cand.priority, lat, cand.fee)

        candidates.sort(key=sort_key)
        return candidates[0]

    def reroute_pending_traffic(
        self,
        deactivated_anchor_id: str,
        corridor: Union[str, Corridor],
    ) -> RerouteBatchReport:
        """Re-routes all pending remittance traffic from an underperforming anchor

        to the best available backup corridor partner.
        """
        c = corridor if isinstance(corridor, Corridor) else Corridor.parse(corridor)
        corridor_key = c.key

        pending_records = [
            r for r in self._records.values()
            if r.corridor.key == corridor_key
            and r.anchor_id == deactivated_anchor_id
            and not r.is_settled
        ]

        total_pending = len(pending_records)
        results: List[RerouteResult] = []
        rerouted_count = 0
        unroutable_count = 0

        backup_partner = self.find_backup_partner(c, excluded_anchor_id=deactivated_anchor_id)
        backup_id = backup_partner.anchor_id if backup_partner else None

        for record in pending_records:
            if backup_partner is not None:
                prev = record.anchor_id
                record.anchor_id = backup_partner.anchor_id
                record.metadata["rerouted_from"] = prev
                record.metadata["rerouted_to"] = backup_partner.anchor_id
                record.metadata["rerouted_at"] = datetime.now(timezone.utc).isoformat()
                record.metadata["reroute_reason"] = "ANCHOR_SLA_BREACH_EXCEEDED_4_HOURS"
                record.status = "REROUTED"

                results.append(
                    RerouteResult(
                        transaction_id=record.transaction_id,
                        corridor=corridor_key,
                        previous_anchor_id=prev,
                        new_anchor_id=backup_partner.anchor_id,
                        success=True,
                        reason="Successfully rerouted to backup corridor partner",
                    )
                )
                rerouted_count += 1
                logger.info(
                    "Re-routed remittance %s in corridor %s from %s to backup partner %s",
                    record.transaction_id,
                    corridor_key,
                    prev,
                    backup_partner.anchor_id,
                )
            else:
                record.metadata["reroute_error"] = "NO_ACTIVE_BACKUP_PARTNER_AVAILABLE"
                results.append(
                    RerouteResult(
                        transaction_id=record.transaction_id,
                        corridor=corridor_key,
                        previous_anchor_id=deactivated_anchor_id,
                        new_anchor_id=None,
                        success=False,
                        reason="No active backup corridor partner available",
                    )
                )
                unroutable_count += 1
                logger.warning(
                    "Unable to reroute remittance %s: No backup partners available in corridor %s",
                    record.transaction_id,
                    corridor_key,
                )

        report = RerouteBatchReport(
            corridor=corridor_key,
            deactivated_anchor_id=deactivated_anchor_id,
            total_pending=total_pending,
            rerouted_count=rerouted_count,
            unroutable_count=unroutable_count,
            backup_partner_assigned=backup_id,
            results=results,
        )
        self._reroute_reports.append(report)
        return report

    def evaluate_anchor(
        self,
        anchor_id: str,
        corridor: Union[str, Corridor],
        window_seconds: Optional[float] = None,
    ) -> Tuple[bool, Optional[SLABreachAuditRecord]]:
        """Evaluates a single anchor against the SLA threshold.

        If T_settlement > 4 hours:
        1. Automatically deactivates the underperforming anchor.
        2. Re-routes pending remittance traffic to backup corridor partner.
        3. Records audit log.
        """
        c = corridor if isinstance(corridor, Corridor) else Corridor.parse(corridor)
        corridor_key = c.key
        metrics = self.get_anchor_metrics(anchor_id, c, window_seconds=window_seconds)

        if not metrics.is_sla_violated:
            return False, None

        # Check if already deactivated
        pair_key = (anchor_id, corridor_key)
        already_deactivated = self._anchor_statuses.get(pair_key) in {
            AnchorHealthStatus.DEACTIVATED,
            AnchorHealthStatus.SLA_BREACHED,
        }

        reason = (
            f"Mean time to settlement T_settlement of {metrics.mean_settlement_hours:.2f}h "
            f"({metrics.mean_settlement_seconds:.1f}s) exceeded {metrics.sla_threshold_hours:.1f}h SLA threshold "
            f"across {metrics.sample_count} samples"
        )

        now = datetime.now(timezone.utc)
        self._anchor_statuses[pair_key] = AnchorHealthStatus.DEACTIVATED
        self._deactivated_at[pair_key] = now
        self._deactivation_reasons[pair_key] = reason

        # Update candidate cache
        if corridor_key in self._registered_partners and anchor_id in self._registered_partners[corridor_key]:
            self._registered_partners[corridor_key][anchor_id].status = AnchorHealthStatus.DEACTIVATED

        logger.warning(
            "🚨 SLA VIOLATION: Deactivated anchor '%s' in corridor '%s'. Reason: %s",
            anchor_id,
            corridor_key,
            reason,
        )

        # Automatically re-route pending remittance traffic to backup partner
        reroute_report = self.reroute_pending_traffic(anchor_id, c)

        audit = SLABreachAuditRecord(
            anchor_id=anchor_id,
            corridor=corridor_key,
            measured_t_settlement_seconds=metrics.mean_settlement_seconds,
            measured_t_settlement_hours=metrics.mean_settlement_hours,
            threshold_seconds=metrics.sla_threshold_seconds,
            threshold_hours=metrics.sla_threshold_hours,
            sample_count=metrics.sample_count,
            deactivated_at=now,
            reason=reason,
            reroute_report=reroute_report,
        )
        self._audit_records.append(audit)
        return True, audit

    def evaluate_all_anchors(
        self,
        corridor: Optional[Union[str, Corridor]] = None,
        window_seconds: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Evaluates all registered/known anchors across one or all corridors.

        Deactivates any violating T_settlement > 4 hours and re-routes pending traffic.
        """
        target_corridors: List[str] = []
        if corridor:
            c = corridor if isinstance(corridor, Corridor) else Corridor.parse(corridor)
            target_corridors.append(c.key)
        else:
            corridor_set = set(self._registered_partners.keys())
            for r in self._records.values():
                corridor_set.add(r.corridor.key)
            target_corridors = sorted(corridor_set)

        total_evaluated = 0
        violations_detected = 0
        deactivated_records: List[Dict[str, Any]] = []

        for c_key in target_corridors:
            c = Corridor.parse(c_key)
            anchors_in_corridor = set()
            if c_key in self._registered_partners:
                anchors_in_corridor.update(self._registered_partners[c_key].keys())
            for r in self._records.values():
                if r.corridor.key == c_key:
                    anchors_in_corridor.add(r.anchor_id)

            for anchor_id in sorted(anchors_in_corridor):
                total_evaluated += 1
                violated, audit = self.evaluate_anchor(anchor_id, c, window_seconds=window_seconds)
                if violated and audit:
                    violations_detected += 1
                    deactivated_records.append(audit.to_dict())

        return {
            "evaluated_anchors": total_evaluated,
            "violations_detected": violations_detected,
            "deactivated_records": deactivated_records,
            "audit_log_count": len(self._audit_records),
        }

    # ------------------------------------------------------------------------
    # Audit & Inspection
    # ------------------------------------------------------------------------

    def get_audit_records(self) -> List[SLABreachAuditRecord]:
        return list(self._audit_records)

    def get_reroute_reports(self) -> List[RerouteBatchReport]:
        return list(self._reroute_reports)

    def reset(self) -> None:
        """Clears all records, metrics, and audit history (useful in test teardown)."""
        self._records.clear()
        self._anchor_statuses.clear()
        self._deactivated_at.clear()
        self._deactivation_reasons.clear()
        self._registered_partners.clear()
        self._audit_records.clear()
        self._reroute_reports.clear()
