"""Tests for Fiat Settlement Latency Monitoring, Anchor Deactivation, and Remittance Re-routing.

Verifies:
1. Mean time to settlement T_settlement tracking per corridor (e.g. USD -> NGN, EUR -> KES).
2. Automated deactivation of underperforming anchors if T_settlement > 4 hours.
3. Automated re-routing of pending remittance traffic to backup corridor partners.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.analytics.fiat_settlement import (
    AnchorHealthStatus,
    AnchorCorridorMetrics,
    BackupPartnerCandidate,
    Corridor,
    DEFAULT_SLA_THRESHOLD_SECONDS,
    FiatSettlementLatencyMonitor,
    RerouteBatchReport,
    RerouteResult,
    SettlementRecord,
    SLABreachAuditRecord,
    calculate_mean_time_to_settlement,
    is_sla_violated,
)
from app.services.fiat_settlement import DatabaseSettlementLatencyWorker


# ============================================================================
# Deliverable 1: Mean Time to Settlement T_settlement Calculations
# ============================================================================

class TestMeanSettlementLatencyCalculation:
    """Tests arithmetic mean calculation T_settlement = (1/N) * sum(Delta t_i)."""

    def test_pure_mean_calculation(self):
        durations = [3600.0, 7200.0, 14400.0]  # 1h, 2h, 4h
        mean_sec = calculate_mean_time_to_settlement(durations)
        assert mean_sec == pytest.approx(8400.0)
        assert (mean_sec / 3600.0) == pytest.approx(8400.0 / 3600.0)

    def test_empty_durations_returns_zero(self):
        assert calculate_mean_time_to_settlement([]) == 0.0

    def test_corridor_parsing_and_equality(self):
        c1 = Corridor.parse("USD -> NGN")
        c2 = Corridor.from_pair("usd", "ngn")
        assert c1.sender_currency == "USD"
        assert c1.receiver_currency == "NGN"
        assert c1 == c2
        assert str(c1) == "USD -> NGN"

        c3 = Corridor.parse("EUR-KES")
        assert c3.sender_currency == "EUR"
        assert c3.receiver_currency == "KES"
        assert str(c3) == "EUR -> KES"

    def test_track_mean_settlement_per_corridor(self):
        monitor = FiatSettlementLatencyMonitor()
        now = datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)

        # Corridor 1: USD -> NGN (Anchor Flutterwave: 30m, 1h, 1.5h -> mean 1h = 3600s)
        monitor.record_dispatch("tx-usd-1", "USD -> NGN", "anchor_fw", 100.0, dispatched_at=now)
        monitor.record_settlement("tx-usd-1", settled_at=now + timedelta(minutes=30))

        monitor.record_dispatch("tx-usd-2", "USD -> NGN", "anchor_fw", 200.0, dispatched_at=now)
        monitor.record_settlement("tx-usd-2", settled_at=now + timedelta(hours=1))

        monitor.record_dispatch("tx-usd-3", "USD -> NGN", "anchor_fw", 300.0, dispatched_at=now)
        monitor.record_settlement("tx-usd-3", settled_at=now + timedelta(hours=1, minutes=30))

        # Corridor 2: EUR -> KES (Anchor MFS: 2h, 3h -> mean 2.5h = 9000s)
        monitor.record_dispatch("tx-eur-1", "EUR -> KES", "anchor_mfs", 500.0, dispatched_at=now)
        monitor.record_settlement("tx-eur-1", settled_at=now + timedelta(hours=2))

        monitor.record_dispatch("tx-eur-2", "EUR -> KES", "anchor_mfs", 600.0, dispatched_at=now)
        monitor.record_settlement("tx-eur-2", settled_at=now + timedelta(hours=3))

        # Verify Corridor 1 latency
        usd_ngn_latency = monitor.calculate_mean_time_to_settlement("USD -> NGN")
        assert usd_ngn_latency == pytest.approx(3600.0)  # exactly 1.0 hour

        # Verify Corridor 2 latency
        eur_kes_latency = monitor.calculate_mean_time_to_settlement("EUR -> KES")
        assert eur_kes_latency == pytest.approx(9000.0)  # exactly 2.5 hours

        # Corridor metrics detail
        usd_metrics = monitor.get_corridor_metrics("USD -> NGN")
        assert usd_metrics.mean_settlement_seconds == pytest.approx(3600.0)
        assert usd_metrics.mean_settlement_hours == pytest.approx(1.0)
        assert usd_metrics.total_completed == 3
        assert usd_metrics.total_pending == 0

        eur_metrics = monitor.get_corridor_metrics("EUR -> KES")
        assert eur_metrics.mean_settlement_seconds == pytest.approx(9000.0)
        assert eur_metrics.mean_settlement_hours == pytest.approx(2.5)
        assert eur_metrics.total_completed == 2

    def test_corridor_isolation_multi_anchor(self):
        """Ensures multiple anchors within same corridor have separate tracking."""
        monitor = FiatSettlementLatencyMonitor()
        now = datetime(2026, 9, 29, 10, 0, 0, tzinfo=timezone.utc)

        # Anchor A in USD -> NGN: 1 hour settlement
        monitor.record_dispatch("tx-1", "USD -> NGN", "anchor_a", 100.0, dispatched_at=now)
        monitor.record_settlement("tx-1", settled_at=now + timedelta(hours=1))

        # Anchor B in USD -> NGN: 3 hour settlement
        monitor.record_dispatch("tx-2", "USD -> NGN", "anchor_b", 100.0, dispatched_at=now)
        monitor.record_settlement("tx-2", settled_at=now + timedelta(hours=3))

        latency_a = monitor.calculate_mean_time_to_settlement("USD -> NGN", anchor_id="anchor_a")
        latency_b = monitor.calculate_mean_time_to_settlement("USD -> NGN", anchor_id="anchor_b")

        assert latency_a == pytest.approx(3600.0)
        assert latency_b == pytest.approx(10800.0)

        # Overall corridor mean: (3600 + 10800) / 2 = 7200s (2h)
        corridor_latency = monitor.calculate_mean_time_to_settlement("USD -> NGN")
        assert corridor_latency == pytest.approx(7200.0)


# ============================================================================
# Deliverable 2: Automated Deactivation of Underperforming Anchors (> 4 Hours)
# ============================================================================

class TestAnchorDeactivationOnSLABreach:
    """Tests automatic deactivation when T_settlement > 4 hours (14,400s)."""

    def test_sla_violation_check_boundaries(self):
        threshold = 14400.0  # 4 hours
        assert not is_sla_violated(14399.0, threshold)  # Below 4h: compliant
        assert not is_sla_violated(14400.0, threshold)  # Exactly 4h: compliant
        assert is_sla_violated(14400.001, threshold)    # > 4h: violated
        assert is_sla_violated(18000.0, threshold)      # 5h: violated

    def test_anchor_under_threshold_remains_active(self):
        monitor = FiatSettlementLatencyMonitor(sla_threshold_seconds=14400.0)
        now = datetime(2026, 9, 29, 8, 0, 0, tzinfo=timezone.utc)

        # Anchor takes 3 hours (10,800s) < 4 hours threshold
        monitor.record_dispatch("tx-ok", "USD -> NGN", "fast_anchor", 1000.0, dispatched_at=now)
        monitor.record_settlement("tx-ok", settled_at=now + timedelta(hours=3))

        violated, audit = monitor.evaluate_anchor("fast_anchor", "USD -> NGN")
        assert not violated
        assert audit is None
        assert monitor.get_anchor_status("fast_anchor", "USD -> NGN") == AnchorHealthStatus.ACTIVE

    def test_anchor_over_4_hours_is_automatically_deactivated(self):
        monitor = FiatSettlementLatencyMonitor(sla_threshold_seconds=14400.0)
        now = datetime(2026, 9, 29, 8, 0, 0, tzinfo=timezone.utc)

        # Anchor takes 4.5 hours (16,200s) > 4 hours SLA threshold
        monitor.record_dispatch("tx-slow-1", "USD -> NGN", "slow_anchor", 1000.0, dispatched_at=now)
        monitor.record_settlement("tx-slow-1", settled_at=now + timedelta(hours=4, minutes=30))

        monitor.record_dispatch("tx-slow-2", "USD -> NGN", "slow_anchor", 2000.0, dispatched_at=now)
        monitor.record_settlement("tx-slow-2", settled_at=now + timedelta(hours=5))

        violated, audit = monitor.evaluate_anchor("slow_anchor", "USD -> NGN")
        assert violated is True
        assert audit is not None
        assert audit.anchor_id == "slow_anchor"
        assert audit.corridor == "USD -> NGN"
        assert audit.measured_t_settlement_hours == pytest.approx(4.75)
        assert audit.measured_t_settlement_seconds == pytest.approx(17100.0)
        assert audit.threshold_hours == 4.0
        assert audit.sample_count == 2
        assert "exceeded 4.0h SLA threshold" in audit.reason

        # Status must now be DEACTIVATED
        assert monitor.get_anchor_status("slow_anchor", "USD -> NGN") == AnchorHealthStatus.DEACTIVATED

    def test_evaluate_all_anchors_deactivates_only_violators(self):
        monitor = FiatSettlementLatencyMonitor(sla_threshold_seconds=14400.0)
        now = datetime(2026, 9, 29, 8, 0, 0, tzinfo=timezone.utc)

        # Anchor 1 (Good): 1.5h
        monitor.record_dispatch("tx-1", "EUR -> KES", "good_anchor", 100.0, dispatched_at=now)
        monitor.record_settlement("tx-1", settled_at=now + timedelta(hours=1, minutes=30))

        # Anchor 2 (Violator): 4.8h
        monitor.record_dispatch("tx-2", "EUR -> KES", "bad_anchor", 100.0, dispatched_at=now)
        monitor.record_settlement("tx-2", settled_at=now + timedelta(hours=4, minutes=48))

        report = monitor.evaluate_all_anchors()
        assert report["evaluated_anchors"] == 2
        assert report["violations_detected"] == 1
        assert len(report["deactivated_records"]) == 1
        assert report["deactivated_records"][0]["anchor_id"] == "bad_anchor"

        assert monitor.get_anchor_status("good_anchor", "EUR -> KES") == AnchorHealthStatus.ACTIVE
        assert monitor.get_anchor_status("bad_anchor", "EUR -> KES") == AnchorHealthStatus.DEACTIVATED


# ============================================================================
# Deliverable 3: Re-route Pending Remittance Traffic to Backup Partners
# ============================================================================

class TestRemittanceReroutingToBackupPartners:
    """Tests automated re-routing of pending remittances when an anchor is deactivated."""

    def test_reroute_pending_traffic_to_active_backup_partner(self):
        monitor = FiatSettlementLatencyMonitor(sla_threshold_seconds=14400.0)
        now = datetime(2026, 9, 29, 10, 0, 0, tzinfo=timezone.utc)

        # Register backup partner for USD -> NGN
        monitor.register_anchor_corridor(
            anchor_id="backup_partner_fast",
            corridor="USD -> NGN",
            priority=10,
            fee=5.0,
            rate=1500.0,
        )

        # Primary underperforming anchor has 1 completed (slow: 5h) and 2 pending transactions
        monitor.record_dispatch("settled-tx", "USD -> NGN", "slow_partner", 500.0, dispatched_at=now)
        monitor.record_settlement("settled-tx", settled_at=now + timedelta(hours=5))

        # Pending remittances in flight
        p1 = monitor.record_dispatch("pending-1", "USD -> NGN", "slow_partner", 1000.0, dispatched_at=now)
        p2 = monitor.record_dispatch("pending-2", "USD -> NGN", "slow_partner", 2000.0, dispatched_at=now)

        assert p1.anchor_id == "slow_partner"
        assert p2.anchor_id == "slow_partner"
        assert not p1.is_settled
        assert not p2.is_settled

        # Evaluate SLA: should trigger deactivation AND re-routing
        violated, audit = monitor.evaluate_anchor("slow_partner", "USD -> NGN")
        assert violated is True
        assert audit is not None
        assert audit.reroute_report is not None

        reroute = audit.reroute_report
        assert reroute.total_pending == 2
        assert reroute.rerouted_count == 2
        assert reroute.unroutable_count == 0
        assert reroute.backup_partner_assigned == "backup_partner_fast"

        # Verify that records are now assigned to the backup partner
        assert p1.anchor_id == "backup_partner_fast"
        assert p1.status == "REROUTED"
        assert p1.metadata["rerouted_from"] == "slow_partner"
        assert p1.metadata["rerouted_to"] == "backup_partner_fast"
        assert p1.metadata["reroute_reason"] == "ANCHOR_SLA_BREACH_EXCEEDED_4_HOURS"

        assert p2.anchor_id == "backup_partner_fast"
        assert p2.status == "REROUTED"

    def test_backup_partner_selection_prioritizes_higher_priority_and_lower_latency(self):
        monitor = FiatSettlementLatencyMonitor()
        corridor = "USD -> NGN"
        now = datetime(2026, 9, 29, 10, 0, 0, tzinfo=timezone.utc)

        # Partner A: priority 5, latency 1h
        monitor.register_anchor_corridor("partner_a", corridor, priority=5)
        monitor.record_dispatch("tx-a", corridor, "partner_a", 100.0, dispatched_at=now)
        monitor.record_settlement("tx-a", settled_at=now + timedelta(hours=1))

        # Partner B: priority 10, latency 2h (Higher priority wins)
        monitor.register_anchor_corridor("partner_b", corridor, priority=10)
        monitor.record_dispatch("tx-b", corridor, "partner_b", 100.0, dispatched_at=now)
        monitor.record_settlement("tx-b", settled_at=now + timedelta(hours=2))

        # Candidate selected for failover when failing partner is "failing_anchor"
        selected = monitor.find_backup_partner(corridor, excluded_anchor_id="failing_anchor")
        assert selected is not None
        assert selected.anchor_id == "partner_b"

    def test_deactivated_partner_is_never_selected_as_backup(self):
        monitor = FiatSettlementLatencyMonitor()
        corridor = "USD -> NGN"

        monitor.register_anchor_corridor("partner_dead", corridor, priority=20)
        monitor.set_anchor_status("partner_dead", corridor, AnchorHealthStatus.DEACTIVATED)

        monitor.register_anchor_corridor("partner_alive", corridor, priority=5)

        selected = monitor.find_backup_partner(corridor, excluded_anchor_id="failing_anchor")
        assert selected is not None
        assert selected.anchor_id == "partner_alive"

    def test_handling_no_available_backup_partner(self):
        monitor = FiatSettlementLatencyMonitor(sla_threshold_seconds=14400.0)
        now = datetime(2026, 9, 29, 10, 0, 0, tzinfo=timezone.utc)

        # Only one anchor in the corridor (no backups registered)
        monitor.record_dispatch("tx-settled", "USD -> NGN", "sole_anchor", 100.0, dispatched_at=now)
        monitor.record_settlement("tx-settled", settled_at=now + timedelta(hours=5))  # > 4h

        pending_tx = monitor.record_dispatch("tx-pending", "USD -> NGN", "sole_anchor", 200.0, dispatched_at=now)

        # Evaluate SLA
        violated, audit = monitor.evaluate_anchor("sole_anchor", "USD -> NGN")
        assert violated is True
        assert audit.reroute_report.total_pending == 1
        assert audit.reroute_report.rerouted_count == 0
        assert audit.reroute_report.unroutable_count == 1
        assert audit.reroute_report.backup_partner_assigned is None

        # Transaction metadata records failure to find backup
        assert pending_tx.metadata["reroute_error"] == "NO_ACTIVE_BACKUP_PARTNER_AVAILABLE"
        assert pending_tx.anchor_id == "sole_anchor"  # Remains in queue with error flag


# ============================================================================
# Database Worker & Celery Integration Tests
# ============================================================================

class TestDatabaseWorkerAndFailoverSync:
    """Tests DatabaseSettlementLatencyWorker reading DB records and persisting failover."""

    @pytest.mark.asyncio
    async def test_database_worker_runs_complete_evaluation_cycle(self):
        now = datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)

        # Mock database connection
        mock_connection = AsyncMock()

        # 1. Mock PaymentRoute table return (2 routes in USD -> NGN: anchor_slow and anchor_backup)
        mock_connection.fetch.side_effect = [
            # First fetch: routes
            [
                {
                    "id": "route-1",
                    "senderCurrency": "USD",
                    "receiverCurrency": "NGN",
                    "provider": "anchor_slow",
                    "rate": 1500.0,
                    "fee": 5.0,
                    "priority": 1,
                    "status": "ACTIVE",
                    "targetRail": "MOBILE_MONEY",
                },
                {
                    "id": "route-2",
                    "senderCurrency": "USD",
                    "receiverCurrency": "NGN",
                    "provider": "anchor_backup",
                    "rate": 1495.0,
                    "fee": 6.0,
                    "priority": 5,
                    "status": "ACTIVE",
                    "targetRail": "BANK_TRANSFER",
                },
            ],
            # Second fetch: RemittanceTransaction records (1 slow completed at 5h, 1 pending)
            [
                {
                    "id": "tx-slow-completed",
                    "senderCurrency": "USD",
                    "receiverCurrency": "NGN",
                    "provider": "anchor_slow",
                    "amount": 500.0,
                    "status": "COMPLETED",
                    "dispatched_at": now - timedelta(hours=6),
                    "settled_at": now - timedelta(hours=1),  # 5 hours duration > 4h
                },
                {
                    "id": "tx-pending-remittance",
                    "senderCurrency": "USD",
                    "receiverCurrency": "NGN",
                    "provider": "anchor_slow",
                    "amount": 1000.0,
                    "status": "PENDING",
                    "dispatched_at": now - timedelta(minutes=15),
                    "settled_at": None,
                },
            ],
        ]

        mock_connection.execute.return_value = "UPDATE 1"

        # Mock pool
        mock_pool = MagicMock()
        mock_pool.close = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_connection)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)

        # Mock Redis
        mock_redis = AsyncMock()

        worker = DatabaseSettlementLatencyWorker(
            database_url="postgres://user:pass@localhost:5432/testdb",
            pool_factory=AsyncMock(return_value=mock_pool),
            redis_factory=MagicMock(return_value=mock_redis),
        )

        result = await worker.run_evaluation_cycle(lookback_hours=24)

        assert result["evaluated_anchors"] == 2
        assert result["violations_detected"] == 1
        assert len(result["deactivated_records"]) == 1

        deactivated_info = result["deactivated_records"][0]
        assert deactivated_info["anchor_id"] == "anchor_slow"
        assert deactivated_info["corridor"] == "USD -> NGN"
        assert deactivated_info["measured_t_settlement_hours"] == pytest.approx(5.0)

        # Check DB updates: PaymentRoute paused, RemittanceTransaction rerouted
        assert mock_connection.execute.call_count == 2
        calls = mock_connection.execute.call_args_list

        # Call 1: UPDATE "PaymentRoute" SET status = 'PAUSED'
        assert "UPDATE \"PaymentRoute\"" in calls[0].args[0]
        assert "PAUSED" in calls[0].args[0]

        # Call 2: UPDATE "RemittanceTransaction" SET provider = backup
        assert "UPDATE \"RemittanceTransaction\"" in calls[1].args[0]
        assert calls[1].args[1] == "anchor_backup"
        assert calls[1].args[2] == "tx-pending-remittance"

        # Check Redis notification publication
        mock_redis.publish.assert_called_once()
        published_channel, published_payload = mock_redis.publish.call_args.args
        assert published_channel == "remittance_tx-pending-remittance"
        assert "PROVIDER_FAILOVER_REROUTED" in published_payload
        assert "anchor_backup" in published_payload


# ============================================================================
# End-to-End Simulation
# ============================================================================

class TestEndToEndSettlementMonitoringAndFailover:
    """Full lifecycle test simulating real-world traffic, latency spike, deactivation, and failover."""

    def test_full_operational_cycle(self):
        monitor = FiatSettlementLatencyMonitor(sla_threshold_seconds=14400.0)
        base_time = datetime(2026, 9, 29, 6, 0, 0, tzinfo=timezone.utc)

        # Two anchors in EUR -> KES: Anchor Alpha and Anchor Beta
        monitor.register_anchor_corridor("anchor_alpha", "EUR -> KES", priority=10, fee=2.0)
        monitor.register_anchor_corridor("anchor_beta", "EUR -> KES", priority=5, fee=3.0)

        # Day 1: Both anchors perform well (Alpha 1h, Beta 2h)
        for i in range(5):
            tx_a = f"alpha-ok-{i}"
            monitor.record_dispatch(tx_a, "EUR -> KES", "anchor_alpha", 100.0, dispatched_at=base_time)
            monitor.record_settlement(tx_a, settled_at=base_time + timedelta(hours=1))

            tx_b = f"beta-ok-{i}"
            monitor.record_dispatch(tx_b, "EUR -> KES", "anchor_beta", 100.0, dispatched_at=base_time)
            monitor.record_settlement(tx_b, settled_at=base_time + timedelta(hours=2))

        # Check initial metrics
        alpha_metrics = monitor.get_anchor_metrics("anchor_alpha", "EUR -> KES")
        assert alpha_metrics.mean_settlement_hours == pytest.approx(1.0)
        assert not alpha_metrics.is_sla_violated

        beta_metrics = monitor.get_anchor_metrics("anchor_beta", "EUR -> KES")
        assert beta_metrics.mean_settlement_hours == pytest.approx(2.0)
        assert not beta_metrics.is_sla_violated

        # Sudden degradation: Anchor Alpha partner experiences regional banking outage!
        # Next 5 settlements for Alpha take 8 hours each!
        outage_time = base_time + timedelta(days=1)
        for i in range(5):
            tx_a_slow = f"alpha-slow-{i}"
            monitor.record_dispatch(tx_a_slow, "EUR -> KES", "anchor_alpha", 200.0, dispatched_at=outage_time)
            monitor.record_settlement(tx_a_slow, settled_at=outage_time + timedelta(hours=8))

        # New in-flight customer remittance requests sent to Alpha
        pending_traffic = [
            monitor.record_dispatch(f"customer-pending-{i}", "EUR -> KES", "anchor_alpha", 500.0, dispatched_at=outage_time)
            for i in range(3)
        ]

        # Mean for Alpha: 5 samples at 1h + 5 samples at 8h = 4.5h (> 4h SLA limit)
        eval_report = monitor.evaluate_all_anchors()

        assert eval_report["violations_detected"] == 1
        assert eval_report["deactivated_records"][0]["anchor_id"] == "anchor_alpha"

        # Anchor Alpha must be DEACTIVATED
        assert monitor.get_anchor_status("anchor_alpha", "EUR -> KES") == AnchorHealthStatus.DEACTIVATED
        # Anchor Beta remains ACTIVE
        assert monitor.get_anchor_status("anchor_beta", "EUR -> KES") == AnchorHealthStatus.ACTIVE

        # All pending customer remittances must be automatically re-routed to Anchor Beta
        for tx in pending_traffic:
            assert tx.anchor_id == "anchor_beta"
            assert tx.status == "REROUTED"
            assert tx.metadata["rerouted_from"] == "anchor_alpha"
            assert tx.metadata["rerouted_to"] == "anchor_beta"

        # Audit logs contain full traceability
        audits = monitor.get_audit_records()
        assert len(audits) == 1
        assert audits[0].anchor_id == "anchor_alpha"
        assert audits[0].reroute_report.rerouted_count == 3
        assert audits[0].reroute_report.backup_partner_assigned == "anchor_beta"


# ============================================================================
# Statistical Robustness & Windowing Tests
# ============================================================================

class TestRollingWindowAndPercentiles:
    """Tests rolling time window exclusion and percentile metrics."""

    def test_rolling_window_excludes_old_settlements(self):
        # 1-hour window (3600 seconds)
        monitor = FiatSettlementLatencyMonitor(rolling_window_seconds=3600.0)
        now = datetime.now(timezone.utc)

        # Old transaction (settled 3 hours ago) - took 10 hours
        monitor.record_dispatch("old-tx", "USD -> NGN", "anchor_test", 100.0, dispatched_at=now - timedelta(hours=13))
        monitor.record_settlement("old-tx", settled_at=now - timedelta(hours=3))

        # Recent transaction (settled 15 minutes ago) - took 1 hour
        monitor.record_dispatch("recent-tx", "USD -> NGN", "anchor_test", 100.0, dispatched_at=now - timedelta(hours=1, minutes=15))
        monitor.record_settlement("recent-tx", settled_at=now - timedelta(minutes=15))

        # Metrics should only include the recent transaction
        metrics = monitor.get_anchor_metrics("anchor_test", "USD -> NGN")
        assert metrics.sample_count == 1
        assert metrics.mean_settlement_hours == pytest.approx(1.0)
        assert not metrics.is_sla_violated

    def test_statistical_aggregates_median_p95_min_max(self):
        monitor = FiatSettlementLatencyMonitor()
        now = datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)
        corridor = "USD -> NGN"

        durations_hours = [1.0, 2.0, 3.0, 4.0, 5.0]
        for idx, h in enumerate(durations_hours):
            tx_id = f"tx-stat-{idx}"
            monitor.record_dispatch(tx_id, corridor, "anchor_stat", 100.0, dispatched_at=now)
            monitor.record_settlement(tx_id, settled_at=now + timedelta(hours=h))

        metrics = monitor.get_anchor_metrics("anchor_stat", corridor)
        assert metrics.sample_count == 5
        assert metrics.min_settlement_seconds == pytest.approx(3600.0)
        assert metrics.max_settlement_seconds == pytest.approx(18000.0)
        assert metrics.median_settlement_seconds == pytest.approx(10800.0)  # 3.0h
        assert metrics.mean_settlement_seconds == pytest.approx(10800.0)    # 3.0h
        assert metrics.std_dev_seconds > 0.0


# ============================================================================
# Custom Threshold Configuration Tests
# ============================================================================

class TestCustomSLAThresholds:
    """Tests configurability of SLA thresholds."""

    def test_custom_strict_2h_sla(self):
        # Strict SLA of 2 hours (7200s)
        monitor = FiatSettlementLatencyMonitor(sla_threshold_seconds=7200.0)
        now = datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)

        # Settlement of 2.5 hours violates 2h SLA
        monitor.record_dispatch("tx-2h", "EUR -> KES", "anchor_custom", 100.0, dispatched_at=now)
        monitor.record_settlement("tx-2h", settled_at=now + timedelta(hours=2, minutes=30))

        violated, audit = monitor.evaluate_anchor("anchor_custom", "EUR -> KES")
        assert violated is True
        assert audit.threshold_hours == 2.0
        assert audit.measured_t_settlement_hours == pytest.approx(2.5)


# ============================================================================
# Router Endpoints Tests
# ============================================================================

class TestRouterEndpoints:
    """Tests FastAPI router endpoints in app/routers/settlement_latency.py."""

    @pytest.mark.asyncio
    async def test_router_functions_directly(self):
        from app.routers.settlement_latency import (
            get_settlement_monitor,
            list_corridors,
            get_corridor_metrics as router_get_corridor_metrics,
            evaluate_sla as router_evaluate_sla,
            get_audit_trail,
        )

        monitor = get_settlement_monitor()
        monitor.reset()

        now = datetime.now(timezone.utc)
        monitor.register_anchor_corridor("anchor_router_backup", "USD -> NGN", priority=10)
        monitor.register_anchor_corridor("anchor_router_slow", "USD -> NGN", priority=1)

        # 5h settlement -> triggers SLA breach
        monitor.record_dispatch("tx-r-slow", "USD -> NGN", "anchor_router_slow", 50.0, dispatched_at=now - timedelta(hours=6))
        monitor.record_settlement("tx-r-slow", settled_at=now - timedelta(hours=1))

        # Pending
        monitor.record_dispatch("tx-r-pending", "USD -> NGN", "anchor_router_slow", 100.0, dispatched_at=now)

        # 1. Test list corridors
        corridors = await list_corridors()
        assert len(corridors) >= 1
        assert any(c["corridor"] == "USD -> NGN" for c in corridors)

        # 2. Test get specific corridor
        usd_metrics = await router_get_corridor_metrics(sender="usd", receiver="ngn")
        assert usd_metrics["corridor"] == "USD -> NGN"
        assert usd_metrics["sender_currency"] == "USD"
        assert usd_metrics["receiver_currency"] == "NGN"

        # 3. Test evaluate SLA
        eval_resp = await router_evaluate_sla(corridor="USD -> NGN")
        assert eval_resp.violations_detected == 1
        assert len(eval_resp.deactivated_records) == 1
        assert eval_resp.deactivated_records[0]["anchor_id"] == "anchor_router_slow"

        # 4. Test audit trail
        audit = await get_audit_trail()
        assert len(audit["audit_records"]) >= 1
        assert len(audit["reroute_reports"]) >= 1
        assert audit["reroute_reports"][0]["rerouted_count"] == 1
        assert audit["reroute_reports"][0]["backup_partner_assigned"] == "anchor_router_backup"

