"""WebSocket SLA monitoring with Prometheus metrics collection.

Issue #973 — Build Automated API Endpoint Performance SLA Monitoring Middleware

This module provides WebSocket-specific SLA monitoring for message-level
latency tracking, connection duration, and throughput metrics. It complements
the HTTP middleware to provide complete coverage of all API endpoints.

WebSocket metrics tracked:
- Message handling latency (time from receive to response/broadcast)
- Connection duration (time from connect to disconnect)
- Message throughput (messages per second)
- Active WebSocket connections
- Error rates (failed message handling, connection errors)
"""

import time
from datetime import datetime
from typing import Optional

import structlog
from prometheus_client import Counter, Gauge, Histogram

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# WebSocket-Specific Prometheus Metrics
# ---------------------------------------------------------------------------

# WebSocket message handling duration
WEBSOCKET_MESSAGE_DURATION_SECONDS = Histogram(
    name="websocket_message_duration_seconds",
    documentation="WebSocket message handling duration in seconds",
    labelnames=["endpoint", "action", "channel"],
    buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5),
)

# WebSocket message counter
WEBSOCKET_MESSAGES_TOTAL = Counter(
    name="websocket_messages_total",
    documentation="Total WebSocket messages processed",
    labelnames=["endpoint", "action", "channel", "status"],
)

# WebSocket connection duration
WEBSOCKET_CONNECTION_DURATION_SECONDS = Histogram(
    name="websocket_connection_duration_seconds",
    documentation="WebSocket connection duration in seconds",
    labelnames=["endpoint"],
    buckets=(1, 5, 10, 30, 60, 300, 600, 1800, 3600, 7200),
)

# Active WebSocket connections gauge
WEBSOCKET_CONNECTIONS_ACTIVE = Gauge(
    name="websocket_connections_active",
    documentation="Number of active WebSocket connections",
    labelnames=["endpoint"],
)

# WebSocket connection events counter
WEBSOCKET_CONNECTIONS_TOTAL = Counter(
    name="websocket_connections_total",
    documentation="Total WebSocket connection events",
    labelnames=["endpoint", "event"],  # event: "connect", "disconnect", "error"
)

# WebSocket SLA violations counter
WEBSOCKET_SLA_VIOLATIONS = Counter(
    name="websocket_sla_violations_total",
    documentation="Total count of WebSocket SLA violations (message latency exceeded threshold)",
    labelnames=["endpoint", "action", "threshold_ms"],
)

# WebSocket message size histograms
WEBSOCKET_MESSAGE_SIZE_BYTES = Histogram(
    name="websocket_message_size_bytes",
    documentation="WebSocket message size in bytes",
    labelnames=["endpoint", "direction"],  # direction: "inbound", "outbound"
    buckets=(100, 500, 1000, 5000, 10000, 50000, 100000),
)

# WebSocket errors counter
WEBSOCKET_ERRORS_TOTAL = Counter(
    name="websocket_errors_total",
    documentation="Total WebSocket errors",
    labelnames=["endpoint", "error_type"],
)


# ---------------------------------------------------------------------------
# WebSocket Message Context Manager
# ---------------------------------------------------------------------------


class WebSocketMessageTracker:
    """Context manager for tracking WebSocket message handling.
    
    Usage:
        async with WebSocketMessageTracker(
            endpoint="/ws/live",
            action="subscribe",
            channel="trade_updates"
        ) as tracker:
            # Handle message
            await process_message(data)
            tracker.set_status("success")
    """
    
    def __init__(
        self,
        endpoint: str,
        action: str = "message",
        channel: Optional[str] = None,
        sla_target_ms: float = 200.0,
    ):
        """Initialize message tracker.
        
        Args:
            endpoint: WebSocket endpoint path (e.g., "/ws/live")
            action: Message action type (e.g., "subscribe", "unsubscribe", "message")
            channel: Optional channel name for pub/sub systems
            sla_target_ms: SLA target for message handling in milliseconds
        """
        self.endpoint = endpoint
        self.action = action
        self.channel = channel or "default"
        self.sla_target_ms = sla_target_ms
        self.start_time = None
        self.status = "unknown"
    
    async def __aenter__(self):
        """Start tracking message handling."""
        self.start_time = time.perf_counter()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Record message handling metrics."""
        if self.start_time is None:
            return False
        
        duration_seconds = time.perf_counter() - self.start_time
        duration_ms = duration_seconds * 1000
        
        # Determine status if not explicitly set
        if exc_type is not None:
            self.status = "error"
        elif self.status == "unknown":
            self.status = "success"
        
        # Record metrics
        WEBSOCKET_MESSAGE_DURATION_SECONDS.labels(
            endpoint=self.endpoint,
            action=self.action,
            channel=self.channel,
        ).observe(duration_seconds)
        
        WEBSOCKET_MESSAGES_TOTAL.labels(
            endpoint=self.endpoint,
            action=self.action,
            channel=self.channel,
            status=self.status,
        ).inc()
        
        # Check for SLA violation
        if duration_ms > self.sla_target_ms:
            WEBSOCKET_SLA_VIOLATIONS.labels(
                endpoint=self.endpoint,
                action=self.action,
                threshold_ms=str(int(self.sla_target_ms)),
            ).inc()
            
            log.warning(
                "websocket_sla.slow_message",
                endpoint=self.endpoint,
                action=self.action,
                channel=self.channel,
                duration_ms=round(duration_ms, 2),
                sla_target_ms=self.sla_target_ms,
                status=self.status,
            )
        
        # Don't suppress exceptions
        return False
    
    def set_status(self, status: str):
        """Explicitly set the message handling status.
        
        Args:
            status: Status string (e.g., "success", "error", "rejected")
        """
        self.status = status


# ---------------------------------------------------------------------------
# WebSocket Connection Context Manager
# ---------------------------------------------------------------------------


class WebSocketConnectionTracker:
    """Context manager for tracking WebSocket connection lifecycle.
    
    Usage:
        async with WebSocketConnectionTracker(endpoint="/ws/live") as tracker:
            await websocket.accept()
            # Connection is active
            await handle_messages()
    """
    
    def __init__(self, endpoint: str):
        """Initialize connection tracker.
        
        Args:
            endpoint: WebSocket endpoint path (e.g., "/ws/live")
        """
        self.endpoint = endpoint
        self.start_time = None
        self.connected = False
    
    async def __aenter__(self):
        """Start tracking connection."""
        self.start_time = time.perf_counter()
        self.connected = True
        
        # Increment active connections
        WEBSOCKET_CONNECTIONS_ACTIVE.labels(endpoint=self.endpoint).inc()
        
        # Record connection event
        WEBSOCKET_CONNECTIONS_TOTAL.labels(
            endpoint=self.endpoint,
            event="connect",
        ).inc()
        
        log.info("websocket_sla.connection_opened", endpoint=self.endpoint)
        
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Record connection metrics on close."""
        if self.start_time is None:
            return False
        
        duration_seconds = time.perf_counter() - self.start_time
        
        # Decrement active connections
        WEBSOCKET_CONNECTIONS_ACTIVE.labels(endpoint=self.endpoint).dec()
        
        # Record connection duration
        WEBSOCKET_CONNECTION_DURATION_SECONDS.labels(
            endpoint=self.endpoint
        ).observe(duration_seconds)
        
        # Record disconnect or error event
        event = "error" if exc_type is not None else "disconnect"
        WEBSOCKET_CONNECTIONS_TOTAL.labels(
            endpoint=self.endpoint,
            event=event,
        ).inc()
        
        if exc_type is not None:
            WEBSOCKET_ERRORS_TOTAL.labels(
                endpoint=self.endpoint,
                error_type=exc_type.__name__,
            ).inc()
            
            log.warning(
                "websocket_sla.connection_error",
                endpoint=self.endpoint,
                duration_seconds=round(duration_seconds, 2),
                error_type=exc_type.__name__,
                error=str(exc_val),
            )
        else:
            log.info(
                "websocket_sla.connection_closed",
                endpoint=self.endpoint,
                duration_seconds=round(duration_seconds, 2),
            )
        
        # Don't suppress exceptions
        return False
    
    def record_message_size(self, size_bytes: int, direction: str = "inbound"):
        """Record message size metric.
        
        Args:
            size_bytes: Message size in bytes
            direction: "inbound" or "outbound"
        """
        WEBSOCKET_MESSAGE_SIZE_BYTES.labels(
            endpoint=self.endpoint,
            direction=direction,
        ).observe(size_bytes)


# ---------------------------------------------------------------------------
# Utility Functions
# ---------------------------------------------------------------------------


def track_websocket_message(
    endpoint: str,
    action: str = "message",
    channel: Optional[str] = None,
    sla_target_ms: float = 200.0,
) -> WebSocketMessageTracker:
    """Create a message tracker context manager.
    
    Args:
        endpoint: WebSocket endpoint path
        action: Message action type
        channel: Optional channel name
        sla_target_ms: SLA target in milliseconds
        
    Returns:
        WebSocketMessageTracker instance
    """
    return WebSocketMessageTracker(endpoint, action, channel, sla_target_ms)


def track_websocket_connection(endpoint: str) -> WebSocketConnectionTracker:
    """Create a connection tracker context manager.
    
    Args:
        endpoint: WebSocket endpoint path
        
    Returns:
        WebSocketConnectionTracker instance
    """
    return WebSocketConnectionTracker(endpoint)


# ---------------------------------------------------------------------------
# WebSocket Handler Decorator
# ---------------------------------------------------------------------------


def monitor_websocket_handler(endpoint: str, sla_target_ms: float = 200.0):
    """Decorator to add SLA monitoring to WebSocket handler functions.
    
    This decorator wraps a WebSocket handler function to automatically track:
    - Connection lifecycle (connect/disconnect)
    - Message handling latency
    - Error rates
    
    Usage:
        @monitor_websocket_handler("/ws/live")
        async def websocket_endpoint(websocket: WebSocket):
            await websocket.accept()
            while True:
                data = await websocket.receive_text()
                await websocket.send_text(f"Echo: {data}")
    
    Args:
        endpoint: WebSocket endpoint path
        sla_target_ms: SLA target for message handling in milliseconds
        
    Returns:
        Decorated handler function
    """
    def decorator(handler_func):
        async def wrapper(*args, **kwargs):
            # Extract the WebSocket instance from args/kwargs
            # It's typically the first argument or a kwarg named 'websocket'
            websocket = None
            if args and hasattr(args[0], 'accept'):
                websocket = args[0]
            elif 'websocket' in kwargs:
                websocket = kwargs['websocket']
            
            # Track the connection lifecycle
            async with track_websocket_connection(endpoint):
                try:
                    # Call the original handler
                    result = await handler_func(*args, **kwargs)
                    return result
                except Exception as exc:
                    # Error is already tracked by the context manager
                    raise
        
        # Preserve function metadata
        wrapper.__name__ = handler_func.__name__
        wrapper.__doc__ = handler_func.__doc__
        return wrapper
    
    return decorator
