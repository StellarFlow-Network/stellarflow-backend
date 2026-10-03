"""SLA monitoring middleware with Prometheus metrics collection.

Issue #973 — Build Automated API Endpoint Performance SLA Monitoring Middleware

This middleware tracks request durations and response status codes for all
REST and WebSocket endpoints, exposing Prometheus metrics for:
- Request duration histograms (P50, P95, P99 latency percentiles)
- Request counters by endpoint, method, and status code
- Active request gauge

The metrics are scraped by Prometheus and used by the SLA alerting service
to detect when P99 latency exceeds 200ms over a 5-minute sliding window.
"""

import time
from typing import Callable

import structlog
from fastapi import Request, Response
from prometheus_client import Counter, Gauge, Histogram
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Prometheus Metrics
# ---------------------------------------------------------------------------

# Request duration histogram with buckets optimized for API latency tracking
# Buckets: 10ms, 25ms, 50ms, 100ms, 200ms, 500ms, 1s, 2.5s, 5s, 10s
REQUEST_DURATION_SECONDS = Histogram(
    name="http_request_duration_seconds",
    documentation="HTTP request duration in seconds",
    labelnames=["method", "endpoint", "status_code"],
    buckets=(0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1.0, 2.5, 5.0, 10.0),
)

# Request counter by endpoint, method, and status code
REQUEST_COUNT = Counter(
    name="http_requests_total",
    documentation="Total HTTP request count",
    labelnames=["method", "endpoint", "status_code"],
)

# Active requests gauge (in-flight requests)
ACTIVE_REQUESTS = Gauge(
    name="http_requests_active",
    documentation="Number of active HTTP requests currently being processed",
    labelnames=["method", "endpoint"],
)

# SLA violation counter (P99 > threshold)
SLA_VIOLATIONS = Counter(
    name="http_sla_violations_total",
    documentation="Total count of SLA violations (P99 latency exceeded threshold)",
    labelnames=["method", "endpoint", "threshold_ms"],
)

# Request size histogram (bytes)
REQUEST_SIZE_BYTES = Histogram(
    name="http_request_size_bytes",
    documentation="HTTP request size in bytes",
    labelnames=["method", "endpoint"],
    buckets=(100, 1000, 10000, 100000, 1000000, 10000000),
)

# Response size histogram (bytes)
RESPONSE_SIZE_BYTES = Histogram(
    name="http_response_size_bytes",
    documentation="HTTP response size in bytes",
    labelnames=["method", "endpoint"],
    buckets=(100, 1000, 10000, 100000, 1000000, 10000000),
)


# ---------------------------------------------------------------------------
# Utility Functions
# ---------------------------------------------------------------------------


def normalize_path(path: str) -> str:
    """Normalize URL path to reduce cardinality in Prometheus labels.
    
    Replaces dynamic path parameters (UUIDs, IDs, etc.) with placeholders
    to prevent label explosion in Prometheus metrics.
    
    Examples:
        /api/v1/users/123 -> /api/v1/users/{id}
        /api/v1/proofs/abc-def-123 -> /api/v1/proofs/{id}
        /health -> /health
    
    Args:
        path: Raw URL path from the request
        
    Returns:
        Normalized path with placeholders for dynamic segments
    """
    import re
    
    # Replace UUIDs (with or without hyphens)
    path = re.sub(
        r'/[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}',
        '/{uuid}',
        path
    )
    path = re.sub(r'/[a-fA-F0-9]{32}', '/{uuid}', path)
    
    # Replace numeric IDs
    path = re.sub(r'/\d+(?=/|$)', '/{id}', path)
    
    # Replace alphanumeric IDs (at least 8 chars, mix of letters and numbers)
    path = re.sub(r'/[a-zA-Z0-9]{8,}(?=/|$)', '/{id}', path)
    
    # Replace Stellar addresses (G... or S... format, 56 chars)
    path = re.sub(r'/[GS][A-Z0-9]{55}(?=/|$)', '/{address}', path)
    
    # Replace transaction hashes (64 hex chars)
    path = re.sub(r'/[a-fA-F0-9]{64}(?=/|$)', '/{hash}', path)
    
    return path


def get_request_size(request: Request) -> int:
    """Estimate request size in bytes from headers.
    
    Args:
        request: FastAPI request object
        
    Returns:
        Request size in bytes (0 if Content-Length header is missing)
    """
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            return int(content_length)
        except ValueError:
            return 0
    return 0


def get_response_size(response: Response) -> int:
    """Estimate response size in bytes from headers.
    
    Args:
        response: FastAPI response object
        
    Returns:
        Response size in bytes (0 if not determinable)
    """
    # For streaming responses, this will be 0 since size isn't known upfront
    content_length = response.headers.get("content-length")
    if content_length:
        try:
            return int(content_length)
        except ValueError:
            return 0
    return 0


# ---------------------------------------------------------------------------
# SLA Monitoring Middleware
# ---------------------------------------------------------------------------


class SLAMonitoringMiddleware(BaseHTTPMiddleware):
    """FastAPI middleware for tracking API endpoint SLA metrics.
    
    This middleware wraps every HTTP request and:
    1. Records request start time and increments active request gauge
    2. Normalizes the endpoint path to reduce metric cardinality
    3. Observes request duration in a Prometheus histogram
    4. Increments request counter with method, endpoint, and status code labels
    5. Tracks request/response sizes
    6. Logs SLA violations when they occur
    
    The collected metrics are exposed via the /metrics endpoint (configured
    in app/main.py) and scraped by Prometheus for alerting and dashboards.
    
    Usage:
        app = FastAPI()
        app.add_middleware(SLAMonitoringMiddleware)
    """
    
    def __init__(
        self,
        app: ASGIApp,
        sla_target_p99_ms: float = 200.0,
        exclude_paths: list[str] | None = None,
    ):
        """Initialize the SLA monitoring middleware.
        
        Args:
            app: ASGI application to wrap
            sla_target_p99_ms: Target P99 latency in milliseconds (default 200ms)
            exclude_paths: List of paths to exclude from monitoring (e.g., /metrics, /health)
        """
        super().__init__(app)
        self.sla_target_p99_ms = sla_target_p99_ms
        self.exclude_paths = exclude_paths or ["/metrics", "/health", "/docs", "/openapi.json", "/redoc"]
        log.info(
            "sla_monitoring.initialized",
            sla_target_p99_ms=sla_target_p99_ms,
            exclude_paths=self.exclude_paths,
        )
    
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        """Process each HTTP request and collect SLA metrics.
        
        Args:
            request: Incoming HTTP request
            call_next: Next middleware or route handler in the chain
            
        Returns:
            HTTP response from the handler
        """
        # Skip monitoring for excluded paths (health checks, metrics endpoint, etc.)
        if request.url.path in self.exclude_paths:
            return await call_next(request)
        
        # Normalize the path to prevent label cardinality explosion
        normalized_path = normalize_path(request.url.path)
        method = request.method
        
        # Track active requests
        ACTIVE_REQUESTS.labels(method=method, endpoint=normalized_path).inc()
        
        # Record request size
        request_size = get_request_size(request)
        if request_size > 0:
            REQUEST_SIZE_BYTES.labels(method=method, endpoint=normalized_path).observe(request_size)
        
        # Start timing
        start_time = time.perf_counter()
        status_code = 500  # Default to 500 in case of unhandled exception
        
        try:
            # Call the next middleware or route handler
            response = await call_next(request)
            status_code = response.status_code
            
            # Record response size
            response_size = get_response_size(response)
            if response_size > 0:
                RESPONSE_SIZE_BYTES.labels(method=method, endpoint=normalized_path).observe(response_size)
            
            return response
            
        except Exception as exc:
            # Log the exception and re-raise
            log.exception(
                "sla_monitoring.request_failed",
                method=method,
                path=normalized_path,
                error=str(exc),
            )
            raise
            
        finally:
            # Calculate request duration
            duration_seconds = time.perf_counter() - start_time
            duration_ms = duration_seconds * 1000
            
            # Record metrics
            REQUEST_DURATION_SECONDS.labels(
                method=method,
                endpoint=normalized_path,
                status_code=status_code,
            ).observe(duration_seconds)
            
            REQUEST_COUNT.labels(
                method=method,
                endpoint=normalized_path,
                status_code=status_code,
            ).inc()
            
            # Decrement active requests
            ACTIVE_REQUESTS.labels(method=method, endpoint=normalized_path).dec()
            
            # Check for SLA violation (individual request exceeds target)
            # Note: This is a single-request check. The alerting service
            # checks the P99 over a 5-minute window for actual SLA alerts.
            if duration_ms > self.sla_target_p99_ms:
                SLA_VIOLATIONS.labels(
                    method=method,
                    endpoint=normalized_path,
                    threshold_ms=str(int(self.sla_target_p99_ms)),
                ).inc()
                
                log.warning(
                    "sla_monitoring.slow_request",
                    method=method,
                    path=normalized_path,
                    duration_ms=round(duration_ms, 2),
                    sla_target_ms=self.sla_target_p99_ms,
                    status_code=status_code,
                )
