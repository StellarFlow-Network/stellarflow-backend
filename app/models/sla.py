"""Database models for API endpoint SLA monitoring and compliance tracking.

Issue #973 — Build Automated API Endpoint Performance SLA Monitoring Middleware

This module defines the schema for storing endpoint-level SLA compliance
scores and performance metrics aggregated over time windows. The middleware
(app.middleware.sla_monitoring) collects real-time metrics, and a background
worker periodically aggregates them into this table for dashboard analytics
and historical trend tracking.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    Float,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """SQLAlchemy declarative base for SLA models."""
    pass


class EndpointSLAMetric(Base):
    """SLA compliance metrics for REST and WebSocket routes.
    
    This table stores aggregated performance data for each endpoint over
    configurable time windows (typically 5 minutes). Metrics include:
    - Request/message counts and success rates
    - Latency percentiles (P50, P95, P99)
    - SLA compliance status (whether P99 stayed under threshold)
    - Error rates by status code category (HTTP) or error type (WebSocket)
    - WebSocket-specific: connection duration, action types, channels
    
    The `endpoint_type` field distinguishes between 'http' and 'websocket' entries.
    Rows are partitioned by `window_start` for efficient time-range queries
    and automatic data retention policies.
    """
    
    __tablename__ = "endpoint_sla_metrics"
    
    # Primary key and temporal partitioning
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    
    # Time window for this aggregated metric snapshot
    window_start = Column(
        DateTime(timezone=True),
        nullable=False,
        index=True,
        comment="Start of the aggregation time window (typically 5-minute intervals)",
    )
    window_end = Column(
        DateTime(timezone=True),
        nullable=False,
        comment="End of the aggregation time window",
    )
    
    # Endpoint identification
    endpoint_type = Column(
        String(16),
        nullable=False,
        default="http",
        index=True,
        comment="Endpoint type: 'http' or 'websocket'",
    )
    http_method = Column(
        String(10),
        nullable=True,
        comment="HTTP method (GET, POST, PUT, DELETE, PATCH, etc.) - NULL for WebSocket",
    )
    route_path = Column(
        String(512),
        nullable=False,
        index=True,
        comment="URL path pattern (e.g., /api/v1/users/{id} or /ws/live)",
    )
    route_name = Column(
        String(256),
        nullable=True,
        comment="Optional route name from FastAPI endpoint definition",
    )
    
    # WebSocket-specific fields
    websocket_action = Column(
        String(64),
        nullable=True,
        comment="WebSocket action type (e.g., 'subscribe', 'unsubscribe', 'message') - NULL for HTTP",
    )
    websocket_channel = Column(
        String(256),
        nullable=True,
        comment="WebSocket channel/topic name - NULL for HTTP",
    )
    total_connections = Column(
        BigInteger,
        nullable=True,
        comment="Total WebSocket connections in this window - NULL for HTTP",
    )
    avg_connection_duration_seconds = Column(
        Float,
        nullable=True,
        comment="Average WebSocket connection duration in seconds - NULL for HTTP",
    )
    
    # Request volume metrics
    total_requests = Column(
        BigInteger,
        nullable=False,
        default=0,
        comment="Total number of requests in this time window",
    )
    success_requests = Column(
        BigInteger,
        nullable=False,
        default=0,
        comment="Requests with 2xx status codes",
    )
    error_4xx_requests = Column(
        BigInteger,
        nullable=False,
        default=0,
        comment="Requests with 4xx client error status codes",
    )
    error_5xx_requests = Column(
        BigInteger,
        nullable=False,
        default=0,
        comment="Requests with 5xx server error status codes",
    )
    
    # Latency percentiles (milliseconds)
    latency_p50_ms = Column(
        Float,
        nullable=True,
        comment="50th percentile (median) request duration in milliseconds",
    )
    latency_p95_ms = Column(
        Float,
        nullable=True,
        comment="95th percentile request duration in milliseconds",
    )
    latency_p99_ms = Column(
        Float,
        nullable=True,
        comment="99th percentile request duration in milliseconds",
    )
    latency_max_ms = Column(
        Float,
        nullable=True,
        comment="Maximum request duration in milliseconds",
    )
    latency_mean_ms = Column(
        Float,
        nullable=True,
        comment="Mean (average) request duration in milliseconds",
    )
    
    # SLA compliance tracking
    sla_target_p99_ms = Column(
        Float,
        nullable=False,
        default=200.0,
        comment="Target P99 latency threshold in milliseconds (default 200ms)",
    )
    sla_compliant = Column(
        Boolean,
        nullable=False,
        default=True,
        index=True,
        comment="True if P99 latency stayed within the SLA target during this window",
    )
    sla_violations = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Number of times P99 exceeded threshold during this window",
    )
    
    # Compliance score (0.0 to 1.0)
    compliance_score = Column(
        Float,
        nullable=True,
        comment=(
            "Overall compliance score (0.0-1.0) based on latency, error rate, "
            "and availability during this window"
        ),
    )
    
    # Alert tracking
    alert_triggered = Column(
        Boolean,
        nullable=False,
        default=False,
        comment="True if an SLA violation alert was sent for this window",
    )
    alert_sent_at = Column(
        DateTime(timezone=True),
        nullable=True,
        comment="Timestamp when the alert notification was sent",
    )
    
    # Metadata
    created_at = Column(
        DateTime(timezone=True),
        nullable=False,
        default=datetime.utcnow,
        comment="When this record was inserted",
    )
    
    # Additional context for debugging
    notes = Column(
        Text,
        nullable=True,
        comment="Optional notes or error details for investigation",
    )
    
    # Constraints and indexes
    __table_args__ = (
        # Ensure we don't duplicate metrics for the same endpoint + time window
        # For HTTP: window_start + http_method + route_path must be unique
        # For WebSocket: window_start + route_path + websocket_action + websocket_channel must be unique
        UniqueConstraint(
            "window_start",
            "endpoint_type",
            "route_path",
            "http_method",
            "websocket_action",
            "websocket_channel",
            name="uq_endpoint_sla_window",
        ),
        # Index for endpoint type filtering
        Index(
            "ix_endpoint_sla_type",
            "endpoint_type",
            "window_start",
        ),
        # Composite index for dashboard queries (recent metrics by endpoint)
        Index(
            "ix_endpoint_sla_route_time",
            "route_path",
            "window_start",
        ),
        # Index for SLA compliance queries (violations in time range)
        Index(
            "ix_endpoint_sla_compliance",
            "sla_compliant",
            "window_start",
        ),
        # Index for alert tracking queries
        Index(
            "ix_endpoint_sla_alerts",
            "alert_triggered",
            "window_start",
        ),
        # Index for WebSocket-specific queries
        Index(
            "ix_endpoint_sla_websocket",
            "endpoint_type",
            "websocket_action",
            "websocket_channel",
        ),
    )
    
    def __repr__(self) -> str:
        if self.endpoint_type == "websocket":
            return (
                f"<EndpointSLAMetric("
                f"type=websocket, route={self.route_path}, "
                f"action={self.websocket_action}, channel={self.websocket_channel}, "
                f"window={self.window_start.isoformat()}, "
                f"p99={self.latency_p99_ms}ms, "
                f"compliant={self.sla_compliant}"
                f")>"
            )
        else:
            return (
                f"<EndpointSLAMetric("
                f"type=http, route={self.http_method} {self.route_path}, "
                f"window={self.window_start.isoformat()}, "
                f"p99={self.latency_p99_ms}ms, "
                f"compliant={self.sla_compliant}"
                f")>"
            )
    
    @property
    def success_rate(self) -> Optional[float]:
        """Calculate success rate as a percentage (0.0 to 100.0)."""
        if self.total_requests == 0:
            return None
        return (self.success_requests / self.total_requests) * 100.0
    
    @property
    def error_rate(self) -> Optional[float]:
        """Calculate error rate as a percentage (0.0 to 100.0)."""
        if self.total_requests == 0:
            return None
        errors = self.error_4xx_requests + self.error_5xx_requests
        return (errors / self.total_requests) * 100.0
    
    @property
    def is_within_sla(self) -> bool:
        """Check if this window's P99 latency is within the SLA target."""
        if self.latency_p99_ms is None:
            return True  # No data means no violation
        return self.latency_p99_ms <= self.sla_target_p99_ms
    
    def calculate_compliance_score(self) -> float:
        """Calculate overall compliance score based on multiple factors.
        
        The score is a weighted combination of:
        - Latency compliance (50%): P99 within target
        - Availability (30%): Success rate
        - Error rate (20%): Lower is better
        
        Returns:
            float: Score from 0.0 (worst) to 1.0 (perfect compliance)
        """
        if self.total_requests == 0:
            return 1.0  # No requests = perfect compliance
        
        # Latency compliance component (50% weight)
        latency_score = 0.0
        if self.latency_p99_ms is not None and self.sla_target_p99_ms > 0:
            # Score drops linearly as P99 exceeds target (2x target = 0.0)
            latency_ratio = self.latency_p99_ms / self.sla_target_p99_ms
            latency_score = max(0.0, min(1.0, 2.0 - latency_ratio))
        else:
            latency_score = 1.0  # No latency data = assume compliant
        
        # Availability component (30% weight)
        success_rate = self.success_rate or 100.0
        availability_score = success_rate / 100.0
        
        # Error rate component (20% weight)
        error_rate = self.error_rate or 0.0
        # Score drops linearly as error rate approaches 50% (50%+ error = 0.0)
        error_score = max(0.0, min(1.0, 1.0 - (error_rate / 50.0)))
        
        # Weighted combination
        score = (
            latency_score * 0.5 +
            availability_score * 0.3 +
            error_score * 0.2
        )
        
        return round(score, 4)
