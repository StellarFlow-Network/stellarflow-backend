from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import requests

from network.multi_region_lb import (
    MultiRegionLoadBalancer,
    NodeEndpoint,
    FAILURE_THRESHOLD_FOR_UNHEALTHY,
)


def make_balancer(**kwargs) -> MultiRegionLoadBalancer:
    return MultiRegionLoadBalancer(
        [
            NodeEndpoint("https://us.example", "us-west"),
            NodeEndpoint("https://eu.example", "eu-central"),
            NodeEndpoint("https://ap.example", "ap-south"),
        ],
        health_check_interval_s=3600.0,
        **kwargs,
    )


def fake_get(status_code: int = 200):
    def _get(url, timeout=None, headers=None):
        response = MagicMock()
        response.status_code = status_code
        return response

    return _get


# ---------------------------------------------------------------------------
# Construction validation
# ---------------------------------------------------------------------------


def test_rejects_empty_endpoint_list():
    with pytest.raises(ValueError):
        MultiRegionLoadBalancer([])


def test_rejects_duplicate_endpoint_urls():
    with pytest.raises(ValueError):
        MultiRegionLoadBalancer(
            [
                NodeEndpoint("https://us.example", "us-west"),
                NodeEndpoint("https://us.example", "eu-central"),
            ]
        )


def test_rejects_endpoint_missing_region():
    with pytest.raises(ValueError):
        NodeEndpoint("https://us.example", "")


def test_initial_active_endpoint_is_first_node():
    lb = make_balancer()
    assert lb.get_current_endpoint() == "https://us.example"
    assert lb.get_current_region() == "us-west"


# ---------------------------------------------------------------------------
# Health scoring
# ---------------------------------------------------------------------------


def test_health_score_full_marks_for_fast_healthy_node():
    lb = make_balancer()
    for _ in range(5):
        lb.record_request_result("https://us.example", True, 100.0)
    health = lb.get_routing_stats().nodes[0]
    assert health["health_score"] == 100.0
    assert health["is_healthy"] is True


def test_health_score_decays_with_high_latency():
    lb = make_balancer()
    for _ in range(5):
        lb.record_request_result("https://us.example", True, 4000.0)
    health = lb.get_routing_stats().nodes[0]
    # avg 4000ms exceeds 2000ms threshold -> latency component penalized
    # and the composite score falls below the 70 health threshold.
    assert health["health_score"] < 100.0
    assert health["health_score"] >= 50.0


def test_node_marked_unhealthy_after_consecutive_failures():
    lb = make_balancer()
    for _ in range(FAILURE_THRESHOLD_FOR_UNHEALTHY):
        lb.record_request_result("https://us.example", False, 2500.0)
    health = lb.get_routing_stats().nodes[0]
    assert health["is_healthy"] is False
    assert health["consecutive_failures"] == FAILURE_THRESHOLD_FOR_UNHEALTHY


# ---------------------------------------------------------------------------
# Routing behavior
# ---------------------------------------------------------------------------


def test_no_failover_while_active_node_healthy():
    lb = make_balancer()
    lb.record_request_result("https://us.example", True, 100.0)
    lb.record_request_result("https://eu.example", True, 200.0)
    assert lb.get_current_endpoint() == "https://us.example"


def test_failover_when_active_node_degrades():
    lb = make_balancer()
    lb.record_request_result("https://eu.example", True, 100.0)
    for _ in range(FAILURE_THRESHOLD_FOR_UNHEALTHY):
        lb.record_request_result("https://us.example", False, 2500.0)
    stats = lb.get_routing_stats()
    assert stats.active_url == "https://eu.example"
    assert stats.failovers_total == 1


def test_failover_falls_back_when_all_nodes_degrade():
    lb = make_balancer()
    for url in ("https://us.example", "https://eu.example", "https://ap.example"):
        for _ in range(FAILURE_THRESHOLD_FOR_UNHEALTHY):
            lb.record_request_result(url, False, 2500.0)
    # All unhealthy: active stays on its current node — no candidate to hop
    # onto. The "kept" endpoint is whichever node the router happened to be
    # pointed at after the cascade.
    stats = lb.get_routing_stats()
    assert stats.active_url in {
        "https://us.example",
        "https://eu.example",
        "https://ap.example",
    }
    assert stats.failovers_total >= 1


def test_route_change_on_decisively_faster_node():
    lb = make_balancer()
    # Active us-west node at 200ms; eu node decisively faster at 100ms (factor 0.7).
    lb.record_request_result("https://us.example", True, 200.0)
    lb.record_request_result("https://eu.example", True, 100.0)
    lb.record_request_result("https://ap.example", True, 190.0)
    assert lb.get_current_endpoint() == "https://eu.example"


def test_hysteresis_prevents_flapping_between_similar_nodes():
    lb = make_balancer()
    # eu at 190ms is faster than 200ms but NOT decisively (needs < 140ms).
    lb.record_request_result("https://us.example", True, 200.0)
    lb.record_request_result("https://eu.example", True, 190.0)
    lb.record_request_result("https://ap.example", True, 195.0)
    assert lb.get_current_endpoint() == "https://us.example"
    assert lb.get_routing_stats().failovers_total == 0


def test_on_failover_callback_invoked():
    events = []
    lb = make_balancer(on_failover=lambda old, new, reason: events.append((old, new, reason)))
    for _ in range(FAILURE_THRESHOLD_FOR_UNHEALTHY):
        lb.record_request_result("https://us.example", False, 2500.0)
    assert len(events) == 1
    old, new, reason = events[0]
    assert old == "https://us.example"
    assert new == "https://eu.example"
    assert reason == "degraded_active"


# ---------------------------------------------------------------------------
# Request routing via route()
# ---------------------------------------------------------------------------


@patch("network.multi_region_lb.requests.post")
def test_route_sends_to_active_endpoint(mock_post):
    lb = make_balancer()
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = {"ok": True}
    mock_post.return_value = response

    result = lb.route("transactions", {"tx": "abc"})
    assert result == {"ok": True}
    assert mock_post.call_args.args[0] == "https://us.example/transactions"


@patch("network.multi_region_lb.requests.post")
def test_route_fails_over_to_next_node_on_failure(mock_post):
    lb = make_balancer()
    good = MagicMock()
    good.status_code = 200
    good.json.return_value = {"ok": True}

    def _post(url, json=None, timeout=None, headers=None):
        if url.startswith("https://us.example"):
            raise requests.exceptions.ConnectionError("node down")
        return good

    mock_post.side_effect = _post
    result = lb.route("transactions", {"tx": "abc"})
    assert result == {"ok": True}
    assert lb.get_current_endpoint() == "https://eu.example"


@patch("network.multi_region_lb.requests.post")
def test_route_raises_when_all_nodes_fail(mock_post):
    lb = make_balancer()
    mock_post.side_effect = requests.exceptions.ConnectionError("down")
    with pytest.raises(ConnectionError):
        lb.route("transactions", {"tx": "abc"})


# ---------------------------------------------------------------------------
# Stats export
# ---------------------------------------------------------------------------


def test_routing_stats_snapshot_shape():
    lb = make_balancer()
    lb.record_request_result("https://us.example", True, 120.0)
    stats = lb.get_routing_stats()
    assert stats.active_region == "us-west"
    assert len(stats.nodes) == 3
    node = stats.nodes[0]
    for key in (
        "url",
        "region",
        "health_score",
        "is_healthy",
        "avg_latency_ms",
        "p95_latency_ms",
        "success_rate",
        "consecutive_failures",
        "total_requests",
    ):
        assert key in node


def test_export_prometheus_contains_core_metrics():
    lb = make_balancer()
    lb.record_request_result("https://us.example", True, 120.0)
    output = lb.export_prometheus()
    assert "stellarflow_rpc_routing_latency_ms" in output
    assert "stellarflow_rpc_node_health_score" in output
    assert "stellarflow_rpc_node_healthy" in output
    assert "stellarflow_rpc_failovers_total" in output
    assert "stellarflow_rpc_active_endpoint_info" in output
    assert 'region="us-west"' in output
    # Exposition format must end with a newline for Prometheus scrapers.
    assert output.endswith("\n")


# ---------------------------------------------------------------------------
# Probe path (health checks against all regions)
# ---------------------------------------------------------------------------


@patch("network.multi_region_lb.requests.get")
def test_run_health_checks_probes_all_regions(mock_get):
    mock_get.side_effect = fake_get(200)
    lb = make_balancer()
    lb.run_health_checks()
    assert mock_get.call_count == 3
    stats = lb.get_routing_stats()
    assert all(node["total_requests"] >= 1 for node in stats.nodes)


@patch("network.multi_region_lb.requests.get")
def test_degraded_probe_response_triggers_failover(mock_get):
    # Active node returns HTTP 500, others healthy.
    def _get(url, timeout=None, headers=None):
        response = MagicMock()
        response.status_code = 500 if url.startswith("https://us.example") else 200
        return response

    mock_get.side_effect = _get
    lb = make_balancer()
    for _ in range(FAILURE_THRESHOLD_FOR_UNHEALTHY):
        lb.run_health_checks()
    assert lb.get_current_endpoint() != "https://us.example"
