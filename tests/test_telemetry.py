"""Tests for app/telemetry.py — OpenTelemetry APM tracing setup (Issue #760).

Uses plain synchronous tests (no pytest-asyncio dependency) since
setup_tracing() and the instrument_*() helpers are themselves synchronous;
see tests/test_dlq_trace_propagation.py for the async DLQ replay coverage.
"""

import importlib
import os

import pytest

import app.telemetry as telemetry


@pytest.fixture(autouse=True)
def _reset_telemetry_state(monkeypatch):
    """Each test gets a clean module (setup_tracing() is deliberately
    idempotent in production, but tests need independent processes)."""
    for key in list(os.environ):
        if key.startswith("TRACING_") or key.startswith("OTEL_"):
            monkeypatch.delenv(key, raising=False)
    telemetry.shutdown_tracing()
    importlib.reload(telemetry)
    yield
    telemetry.shutdown_tracing()


def test_tracing_disabled_by_default():
    assert telemetry.is_tracing_enabled() is False


def test_setup_tracing_is_noop_when_disabled():
    provider = telemetry.setup_tracing()
    assert provider is None
    # instrument_*() must not raise even though nothing was configured.
    telemetry.instrument_http_clients()
    telemetry.instrument_datastores()
    telemetry.instrument_celery()


def test_setup_tracing_enabled_returns_provider(monkeypatch):
    monkeypatch.setenv("TRACING_ENABLED", "true")
    monkeypatch.setenv("TRACING_CONSOLE_EXPORTER", "true")
    monkeypatch.setenv("TRACING_SERVICE_NAME", "test-service")

    provider = telemetry.setup_tracing()
    assert provider is not None

    resource_attrs = dict(provider.resource.attributes)
    assert resource_attrs["service.name"] == "test-service"


def test_setup_tracing_is_idempotent(monkeypatch):
    monkeypatch.setenv("TRACING_ENABLED", "true")
    monkeypatch.setenv("TRACING_CONSOLE_EXPORTER", "true")

    first = telemetry.setup_tracing()
    second = telemetry.setup_tracing(service_name="ignored-on-second-call")
    assert first is second


def test_default_service_name_differs_from_node_default(monkeypatch):
    # Deliberately distinct default from the Node service's "stellarflow-backend"
    # (src/config/tracingConfig.ts) so Jaeger's service map shows two nodes.
    assert telemetry.DEFAULT_SERVICE_NAME != "stellarflow-backend"
    assert telemetry.DEFAULT_SERVICE_NAME == "stellarflow-python"


def test_sampling_rate_is_clamped(monkeypatch):
    monkeypatch.setenv("TRACING_ENABLED", "true")
    monkeypatch.setenv("TRACING_CONSOLE_EXPORTER", "true")
    monkeypatch.setenv("TRACING_SAMPLING_RATE", "5.0")  # out of range

    # Should not raise; sampler construction clamps to [0, 1].
    provider = telemetry.setup_tracing()
    assert provider is not None