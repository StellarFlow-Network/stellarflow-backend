"""OpenTelemetry APM tracing setup for the StellarFlow Python service.

Issue #760 — Implement OpenTelemetry APM Tracing Across Microservices

This mirrors the tracing configuration already used by the Node/TypeScript
half of the stack (see ``src/lib/tracing.ts`` and
``src/config/tracingConfig.ts``): the same ``TRACING_*`` environment
variables select the same exporters, and both processes propagate context
with the W3C ``traceparent``/``tracestate`` headers, so a single Jaeger or
OTLP collector backend can stitch a request that crosses the Node API and
this Python service into one trace.

Usage
-----
Call :func:`setup_tracing` once per process, as early as possible (before
the FastAPI app or Celery app object is constructed), then attach the
relevant instrumentors:

>>> setup_tracing()
>>> instrument_http_clients()   # aiohttp client spans (AnchorStatusPoller, ...)
>>> instrument_datastores()     # asyncpg + redis spans
>>> instrument_fastapi_app(app) # once the FastAPI app object exists

Call :func:`instrument_celery` from ``app/celery_app.py`` — Celery workers
run in a separate process and need their own ``setup_tracing()`` call.

Every function here degrades gracefully: if tracing is disabled
(``TRACING_ENABLED`` unset/false) or an optional instrumentation package
isn't installed, the call is a documented no-op rather than a hard failure,
matching the defensive ``try/except ImportError`` style used elsewhere in
this codebase (see ``app/main.py``'s ``_HAS_REVENUE_ROUTER``).
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Optional

from opentelemetry import trace
from opentelemetry.propagate import set_global_textmap
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.baggage.propagation import W3CBaggagePropagator
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from opentelemetry.sdk.resources import SERVICE_NAME, SERVICE_VERSION, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter, SpanExporter
from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased

logger = logging.getLogger(__name__)

#: Default service.name for this process when TRACING_SERVICE_NAME is unset.
#: Deliberately distinct from the Node service's default ("stellarflow-backend")
#: so Jaeger's service map shows the two microservices as separate nodes.
DEFAULT_SERVICE_NAME = "stellarflow-python"
DEFAULT_SERVICE_VERSION = "1.0.0"

_lock = threading.Lock()
_tracer_provider: Optional[TracerProvider] = None
_configured = False


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        logger.warning("[Tracing] Invalid float for %s=%r, using default %s", name, value, default)
        return default


def is_tracing_enabled() -> bool:
    """Whether TRACING_ENABLED is set, matching the Node service's flag."""
    return _env_bool("TRACING_ENABLED", False)

def _build_exporters() -> list[SpanExporter]:
    exporters: list[SpanExporter] = []

    if _env_bool("TRACING_CONSOLE_EXPORTER", False):
        exporters.append(ConsoleSpanExporter())

    # Generic OTLP collector endpoint. Modern Jaeger (1.35+) accepts OTLP
    # directly, so this is the preferred export path; falls back to the
    # standard OTEL_EXPORTER_OTLP_ENDPOINT var if the StellarFlow-specific
    # one isn't set.
    otlp_endpoint = os.getenv("TRACING_OTLP_ENDPOINT") or os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
    if otlp_endpoint:
        try:
            from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

            exporters.append(OTLPSpanExporter(endpoint=otlp_endpoint))
            logger.info("[Tracing] OTLP exporter targeting %s", otlp_endpoint)
        except ImportError:
            logger.warning(
                "[Tracing] TRACING_OTLP_ENDPOINT is set but "
                "opentelemetry-exporter-otlp-proto-http is not installed; skipping OTLP export."
            )

    # Legacy Jaeger Thrift collector endpoint — same variable name and
    # collector URL shape (http://host:14268/api/traces) as the Node
    # service's TRACING_JAEGER_ENDPOINT, for deployments still on a
    # Jaeger collector without OTLP ingestion enabled.
    jaeger_endpoint = os.getenv("TRACING_JAEGER_ENDPOINT")
    if jaeger_endpoint:
        try:
            from opentelemetry.exporter.jaeger.thrift import JaegerExporter

            exporters.append(JaegerExporter(collector_endpoint=jaeger_endpoint))
            logger.info("[Tracing] Jaeger exporter targeting %s", jaeger_endpoint)
        except ImportError:
            logger.warning(
                "[Tracing] TRACING_JAEGER_ENDPOINT is set but "
                "opentelemetry-exporter-jaeger-thrift is not installed; skipping Jaeger export."
            )

    if not exporters:
        # Tracing is enabled but no destination is configured — fall back to
        # the console exporter so spans are still visible instead of silently
        # dropped, mirroring initializeOpenTelemetry()'s behaviour in
        # src/lib/tracing.ts.
        exporters.append(ConsoleSpanExporter())

    return exporters

def setup_tracing(service_name: Optional[str] = None) -> Optional[TracerProvider]:
    """Initialise the global OpenTelemetry TracerProvider for this process.

    Idempotent and safe to call from multiple entrypoints (FastAPI app
    import, Celery worker bootstrap, tests) — only the first call in a
    process takes effect. Returns ``None`` when tracing is disabled via
    ``TRACING_ENABLED`` (the default), so callers never pay the SDK/export
    cost in environments that haven't opted in.
    """
    global _tracer_provider, _configured

    with _lock:
        if _configured:
            return _tracer_provider

        _configured = True

        if not is_tracing_enabled():
            logger.info("[Tracing] Tracing is disabled (set TRACING_ENABLED=true to enable)")
            return None

        resolved_name = service_name or os.getenv("TRACING_SERVICE_NAME", DEFAULT_SERVICE_NAME)
        resource = Resource.create(
            {
                SERVICE_NAME: resolved_name,
                SERVICE_VERSION: os.getenv("SERVICE_VERSION", DEFAULT_SERVICE_VERSION),
            }
        )

        sampling_rate = min(max(_env_float("TRACING_SAMPLING_RATE", 1.0), 0.0), 1.0)
        sampler = ParentBased(TraceIdRatioBased(sampling_rate))

        provider = TracerProvider(resource=resource, sampler=sampler)
        for exporter in _build_exporters():
            provider.add_span_processor(BatchSpanProcessor(exporter))

        trace.set_tracer_provider(provider)

        # W3C trace context + baggage propagation — the same propagator the
        # Node service installs (src/lib/tracing.ts -> W3CTraceContextPropagator)
        # so traceparent/tracestate headers are interchangeable across both
        # halves of the stack and across the Celery/RabbitMQ task queue.
        set_global_textmap(CompositePropagator([TraceContextTextMapPropagator(), W3CBaggagePropagator()]))

        _tracer_provider = provider
        logger.info(
            "[Tracing] OpenTelemetry SDK initialized (service=%s, sampling=%.2f)",
            resolved_name,
            sampling_rate,
        )
        return provider


def instrument_fastapi_app(app) -> None:
    """Instrument a FastAPI app instance so every endpoint gets a request
    span (method, route, status code) with the incoming ``traceparent``
    header, if present, set as the span's parent."""
    if not is_tracing_enabled():
        return
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor.instrument_app(app)
        logger.info("[Tracing] FastAPI app instrumented")
    except ImportError:
        logger.warning(
            "[Tracing] opentelemetry-instrumentation-fastapi not installed; "
            "FastAPI endpoints will not be traced."
        )


def instrument_http_clients() -> None:
    """Instrument outbound HTTP client libraries (aiohttp) so every outbound
    call — e.g. ``AnchorStatusPoller.fetch_status``'s SEP-24/SEP-31 polling
    requests — gets a client span with the W3C ``traceparent`` header
    injected automatically."""
    if not is_tracing_enabled():
        return
    try:
        from opentelemetry.instrumentation.aiohttp_client import AioHttpClientInstrumentor

        AioHttpClientInstrumentor().instrument()
        logger.info("[Tracing] aiohttp client instrumented")
    except ImportError:
        logger.warning(
            "[Tracing] opentelemetry-instrumentation-aiohttp-client not installed; "
            "outbound aiohttp calls will not be traced."
        )


def instrument_datastores() -> None:
    """Instrument asyncpg (Postgres) and redis so DB/cache calls show up as
    child spans of the request/task that issued them, giving full
    request-flow visibility rather than just the service boundary."""
    if not is_tracing_enabled():
        return
    try:
        from opentelemetry.instrumentation.asyncpg import AsyncPGInstrumentor

        AsyncPGInstrumentor().instrument()
        logger.info("[Tracing] asyncpg instrumented")
    except ImportError:
        logger.warning("[Tracing] opentelemetry-instrumentation-asyncpg not installed; DB spans disabled.")

    try:
        from opentelemetry.instrumentation.redis import RedisInstrumentor

        RedisInstrumentor().instrument()
        logger.info("[Tracing] redis client instrumented")
    except ImportError:
        logger.warning("[Tracing] opentelemetry-instrumentation-redis not installed; Redis spans disabled.")


def instrument_celery() -> None:
    """Instrument Celery so task publish/run/retry/failure spans are
    created automatically, and — critically — so W3C trace context is
    propagated through the task message headers across the RabbitMQ broker:
    a span started while handling an HTTP request that calls
    ``task.delay()``/``apply_async()`` continues, as a child span, inside
    the celery-worker process that picks the task up."""
    if not is_tracing_enabled():
        return
    try:
        from opentelemetry.instrumentation.celery import CeleryInstrumentor

        CeleryInstrumentor().instrument()
        logger.info("[Tracing] Celery instrumented (publish/run spans + context propagation)")
    except ImportError:
        logger.warning(
            "[Tracing] opentelemetry-instrumentation-celery not installed; "
            "Celery task spans and cross-process context propagation are disabled."
        )


def get_tracer(name: str):
    """Return a tracer for manual instrumentation (custom spans)."""
    return trace.get_tracer(name)


def shutdown_tracing() -> None:
    """Flush buffered spans and shut down the exporter pipeline. Safe to
    call even when tracing was never enabled."""
    global _tracer_provider, _configured
    with _lock:
        if _tracer_provider is not None:
            try:
                _tracer_provider.shutdown()
            except Exception:  # noqa: BLE001 - best-effort on shutdown
                logger.exception("[Tracing] Error shutting down tracer provider")
            _tracer_provider = None
        _configured = False
