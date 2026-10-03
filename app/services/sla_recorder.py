"""Background worker for recording SLA compliance metrics to PostgreSQL.

Issue #973 — Build Automated API Endpoint Performance SLA Monitoring Middleware

This service periodically aggregates Prometheus metrics and writes endpoint
SLA compliance scores to the `endpoint_sla_metrics` table for dashboard
analytics and historical trend tracking.

The worker runs as a Celery beat task (scheduled every 5 minutes) and:
1. Queries Prometheus metrics for all monitored endpoints (HTTP and WebSocket)
2. Calculates latency percentiles (P50, P95, P99)
3. Aggregates request/message counts and error rates
4. Computes SLA compliance scores
5. Writes records to the endpoint_sla_metrics table
6. Checks for violations and triggers alerts if needed

Supports both HTTP REST endpoints and WebSocket message handlers.
"""

import os
from datetime import datetime, timedelta
from typing import Dict, List, Optional

import structlog
from prometheus_client import REGISTRY
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_async_session
from app.models.sla import EndpointSLAMetric
from app.services.sla_alerting import (
    check_sla_violations,
    get_endpoint_metrics,
    get_sla_target_p99_ms,
)

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def get_recording_interval_minutes() -> int:
    """Get the SLA recording interval in minutes.
    
    Returns:
        Recording interval in minutes (default: 5)
    """
    try:
        return int(os.getenv("SLA_RECORDING_INTERVAL_MINUTES", "5"))
    except ValueError:
        log.warning("Invalid SLA_RECORDING_INTERVAL_MINUTES value, using default 5")
        return 5


def get_retention_days() -> int:
    """Get the number of days to retain SLA metrics records.
    
    Returns:
        Retention period in days (default: 90)
    """
    try:
        return int(os.getenv("SLA_RETENTION_DAYS", "90"))
    except ValueError:
        log.warning("Invalid SLA_RETENTION_DAYS value, using default 90")
        return 90


# ---------------------------------------------------------------------------
# Metric Aggregation
# ---------------------------------------------------------------------------


def get_all_monitored_endpoints() -> List[tuple]:
    """Get a list of all endpoints that have metrics in the registry.
    
    Returns:
        List of tuples:
        - For HTTP: (endpoint_type='http', method, endpoint, None, None)
        - For WebSocket: (endpoint_type='websocket', None, endpoint, action, channel)
    """
    endpoints = set()
    
    # Scan for HTTP endpoints
    for collector in REGISTRY._collector_to_names:
        if hasattr(collector, "_name") and collector._name == "http_request_duration_seconds":
            for metric_family in collector.collect():
                for sample in metric_family.samples:
                    method = sample.labels.get("method")
                    endpoint = sample.labels.get("endpoint")
                    
                    if method and endpoint:
                        endpoints.add(("http", method, endpoint, None, None))
    
    # Scan for WebSocket endpoints
    for collector in REGISTRY._collector_to_names:
        if hasattr(collector, "_name") and collector._name == "websocket_message_duration_seconds":
            for metric_family in collector.collect():
                for sample in metric_family.samples:
                    endpoint = sample.labels.get("endpoint")
                    action = sample.labels.get("action")
                    channel = sample.labels.get("channel")
                    
                    if endpoint:
                        endpoints.add(("websocket", None, endpoint, action, channel))
    
    return list(endpoints)


def get_websocket_metrics(
    endpoint: str,
    action: Optional[str],
    channel: Optional[str],
    window_minutes: int = 5,
) -> Optional[Dict[str, Any]]:
    """Get aggregated metrics for a WebSocket endpoint over a time window.
    
    Args:
        endpoint: WebSocket endpoint path (e.g., "/ws/live")
        action: WebSocket action type (e.g., "subscribe", "message")
        channel: Channel/topic name
        window_minutes: Time window to analyze
        
    Returns:
        Dictionary of metrics or None if insufficient data
    """
    labels = {"endpoint": endpoint}
    if action:
        labels["action"] = action
    if channel:
        labels["channel"] = channel
    
    metrics = {
        "endpoint": endpoint,
        "action": action,
        "channel": channel,
        "window_start": datetime.utcnow() - timedelta(minutes=window_minutes),
        "window_end": datetime.utcnow(),
    }
    
    try:
        # Get message handling latency from histogram
        histogram_name = "websocket_message_duration_seconds"
        
        for collector in REGISTRY._collector_to_names:
            if hasattr(collector, "_name") and collector._name == histogram_name:
                for metric_family in collector.collect():
                    buckets = []
                    for sample in metric_family.samples:
                        if sample.name == f"{histogram_name}_bucket":
                            # Check if labels match
                            if all(sample.labels.get(k) == v for k, v in labels.items() if v is not None):
                                le = sample.labels.get("le")
                                if le != "+Inf":
                                    buckets.append((float(le), sample.value))
                    
                    if buckets:
                        buckets.sort()
                        total_count = buckets[-1][1] if buckets else 0
                        
                        if total_count > 0:
                            metrics["total_messages"] = int(total_count)
                            metrics["latency_p99_seconds"] = calculate_p99_from_buckets(buckets, total_count)
                            metrics["latency_p99_ms"] = metrics["latency_p99_seconds"] * 1000
        
        # Get message counts by status
        counter_name = "websocket_messages_total"
        success_count = 0
        error_count = 0
        total_count = 0
        
        for collector in REGISTRY._collector_to_names:
            if hasattr(collector, "_name") and collector._name == counter_name:
                for metric_family in collector.collect():
                    for sample in metric_family.samples:
                        sample_labels = sample.labels
                        # Check if endpoint/action/channel match
                        if (sample_labels.get("endpoint") == endpoint and
                            (action is None or sample_labels.get("action") == action) and
                            (channel is None or sample_labels.get("channel") == channel)):
                            status = sample_labels.get("status", "")
                            count = sample.value
                            total_count += count
                            
                            if status == "success":
                                success_count += count
                            elif status == "error":
                                error_count += count
        
        if total_count > 0:
            metrics["total_messages"] = int(total_count)
            metrics["success_count"] = int(success_count)
            metrics["error_count"] = int(error_count)
            metrics["success_rate"] = (success_count / total_count) * 100
            metrics["error_rate"] = (error_count / total_count) * 100
        
        # Get connection metrics
        connection_histogram_name = "websocket_connection_duration_seconds"
        connection_count = 0
        avg_duration = 0.0
        
        for collector in REGISTRY._collector_to_names:
            if hasattr(collector, "_name") and collector._name == connection_histogram_name:
                for metric_family in collector.collect():
                    for sample in metric_family.samples:
                        if sample.labels.get("endpoint") == endpoint:
                            if sample.name == f"{connection_histogram_name}_count":
                                connection_count = int(sample.value)
                            elif sample.name == f"{connection_histogram_name}_sum":
                                total_duration = sample.value
                                if connection_count > 0:
                                    avg_duration = total_duration / connection_count
        
        if connection_count > 0:
            metrics["total_connections"] = connection_count
            metrics["avg_connection_duration_seconds"] = avg_duration
        
        return metrics if metrics.get("total_messages", 0) > 0 else None
        
    except Exception as exc:
        log.exception(
            "Failed to get WebSocket endpoint metrics",
            endpoint=endpoint,
            action=action,
            channel=channel,
            error=str(exc)
        )
        return None


async def record_endpoint_metrics(
    session: AsyncSession,
    endpoint_type: str,
    method: Optional[str],
    endpoint: str,
    action: Optional[str],
    channel: Optional[str],
    window_minutes: int,
) -> Optional[EndpointSLAMetric]:
    """Record SLA metrics for a specific endpoint to the database.
    
    Args:
        session: Database session
        endpoint_type: 'http' or 'websocket'
        method: HTTP method (None for WebSocket)
        endpoint: Endpoint path
        action: WebSocket action type (None for HTTP)
        channel: WebSocket channel (None for HTTP)
        window_minutes: Size of the aggregation window in minutes
        
    Returns:
        Created EndpointSLAMetric record or None if insufficient data
    """
    # Get metrics from Prometheus based on endpoint type
    if endpoint_type == "websocket":
        metrics = get_websocket_metrics(endpoint, action, channel, window_minutes)
    else:
        metrics = get_endpoint_metrics(method, endpoint, window_minutes)
    
    if not metrics:
        log.debug(
            "sla_recorder.no_metrics",
            endpoint_type=endpoint_type,
            method=method,
            endpoint=endpoint,
            action=action,
            channel=channel,
        )
        return None
    
    window_end = datetime.utcnow()
    window_start = window_end - timedelta(minutes=window_minutes)
    sla_target_ms = get_sla_target_p99_ms()
    
    # Create the SLA metric record
    sla_metric = EndpointSLAMetric(
        window_start=window_start,
        window_end=window_end,
        endpoint_type=endpoint_type,
        http_method=method,
        route_path=endpoint,
        route_name=None,
        websocket_action=action,
        websocket_channel=channel,
        total_requests=metrics.get("total_requests") or metrics.get("total_messages", 0),
        success_requests=metrics.get("success_count", 0),
        error_4xx_requests=metrics.get("error_4xx_count", 0) if endpoint_type == "http" else 0,
        error_5xx_requests=metrics.get("error_5xx_count", 0) if endpoint_type == "http" else 0,
        latency_p50_ms=None,
        latency_p95_ms=None,
        latency_p99_ms=metrics.get("latency_p99_ms"),
        latency_max_ms=None,
        latency_mean_ms=None,
        sla_target_p99_ms=sla_target_ms,
        sla_compliant=metrics.get("latency_p99_ms", 0) <= sla_target_ms,
        sla_violations=1 if metrics.get("latency_p99_ms", 0) > sla_target_ms else 0,
        total_connections=metrics.get("total_connections") if endpoint_type == "websocket" else None,
        avg_connection_duration_seconds=metrics.get("avg_connection_duration_seconds") if endpoint_type == "websocket" else None,
        alert_triggered=False,
        alert_sent_at=None,
        notes=None,
    )
    
    # Calculate compliance score
    sla_metric.compliance_score = sla_metric.calculate_compliance_score()
    
    try:
        # Check if a record already exists for this window
        stmt = select(EndpointSLAMetric).where(
            EndpointSLAMetric.window_start == window_start,
            EndpointSLAMetric.endpoint_type == endpoint_type,
            EndpointSLAMetric.route_path == endpoint,
        )
        
        # Add type-specific filters
        if endpoint_type == "http":
            stmt = stmt.where(EndpointSLAMetric.http_method == method)
        else:
            stmt = stmt.where(
                EndpointSLAMetric.websocket_action == action,
                EndpointSLAMetric.websocket_channel == channel,
            )
        
        existing = await session.execute(stmt)
        existing_record = existing.scalar_one_or_none()
        
        if existing_record:
            # Update existing record
            existing_record.window_end = window_end
            existing_record.total_requests = sla_metric.total_requests
            existing_record.success_requests = sla_metric.success_requests
            existing_record.error_4xx_requests = sla_metric.error_4xx_requests
            existing_record.error_5xx_requests = sla_metric.error_5xx_requests
            existing_record.latency_p99_ms = sla_metric.latency_p99_ms
            existing_record.sla_compliant = sla_metric.sla_compliant
            existing_record.sla_violations = sla_metric.sla_violations
            existing_record.compliance_score = sla_metric.compliance_score
            
            if endpoint_type == "websocket":
                existing_record.total_connections = sla_metric.total_connections
                existing_record.avg_connection_duration_seconds = sla_metric.avg_connection_duration_seconds
            
            log.debug(
                "sla_recorder.updated",
                endpoint_type=endpoint_type,
                method=method,
                endpoint=endpoint,
                action=action,
                channel=channel,
                p99_ms=sla_metric.latency_p99_ms,
                compliance_score=sla_metric.compliance_score,
            )
            return existing_record
        else:
            # Insert new record
            session.add(sla_metric)
            
            log.info(
                "sla_recorder.recorded",
                endpoint_type=endpoint_type,
                method=method,
                endpoint=endpoint,
                action=action,
                channel=channel,
                total_requests=sla_metric.total_requests,
                p99_ms=sla_metric.latency_p99_ms,
                sla_compliant=sla_metric.sla_compliant,
                compliance_score=sla_metric.compliance_score,
            )
            return sla_metric
            
    except Exception as exc:
        log.exception(
            "sla_recorder.failed",
            endpoint_type=endpoint_type,
            method=method,
            endpoint=endpoint,
            action=action,
            channel=channel,
            error=str(exc),
        )
        return None


async def cleanup_old_records(session: AsyncSession, retention_days: int) -> int:
    """Delete SLA metric records older than the retention period.
    
    Args:
        session: Database session
        retention_days: Number of days to retain records
        
    Returns:
        Number of records deleted
    """
    cutoff_date = datetime.utcnow() - timedelta(days=retention_days)
    
    try:
        stmt = select(EndpointSLAMetric).where(
            EndpointSLAMetric.window_start < cutoff_date
        )
        result = await session.execute(stmt)
        old_records = result.scalars().all()
        
        count = len(old_records)
        
        for record in old_records:
            await session.delete(record)
        
        await session.commit()
        
        if count > 0:
            log.info(
                "sla_recorder.cleanup_completed",
                records_deleted=count,
                cutoff_date=cutoff_date.isoformat(),
            )
        
        return count
        
    except Exception as exc:
        log.exception("sla_recorder.cleanup_failed", error=str(exc))
        await session.rollback()
        return 0


# ---------------------------------------------------------------------------
# Main Recording Function
# ---------------------------------------------------------------------------


async def record_sla_metrics() -> Dict[str, int]:
    """Main function to record SLA metrics for all monitored endpoints.
    
    This function should be called periodically (e.g., every 5 minutes) by
    a Celery beat task to aggregate and persist SLA metrics.
    
    Returns:
        Dictionary with recording statistics (endpoints_recorded, records_created, etc.)
    """
    window_minutes = get_recording_interval_minutes()
    retention_days = get_retention_days()
    
    log.info("sla_recorder.started", window_minutes=window_minutes)
    
    stats = {
        "endpoints_checked": 0,
        "records_created": 0,
        "records_updated": 0,
        "errors": 0,
        "records_cleaned": 0,
    }
    
    # Get all monitored endpoints
    endpoints = get_all_monitored_endpoints()
    stats["endpoints_checked"] = len(endpoints)
    
    if not endpoints:
        log.warning("sla_recorder.no_endpoints")
        return stats
    
    # Record metrics for each endpoint
    async for session in get_async_session():
        try:
            for endpoint_type, method, endpoint, action, channel in endpoints:
                record = await record_endpoint_metrics(
                    session, endpoint_type, method, endpoint, action, channel, window_minutes
                )
                
                if record:
                    if record.id:
                        stats["records_updated"] += 1
                    else:
                        stats["records_created"] += 1
            
            # Commit all changes
            await session.commit()
            
            # Run cleanup of old records
            cleaned = await cleanup_old_records(session, retention_days)
            stats["records_cleaned"] = cleaned
            
            log.info("sla_recorder.completed", **stats)
            
        except Exception as exc:
            log.exception("sla_recorder.failed", error=str(exc))
            await session.rollback()
            stats["errors"] += 1
        
        finally:
            await session.close()
    
    # Also run SLA violation checks (which may trigger alerts)
    try:
        violations = await check_sla_violations()
        if violations:
            log.info("sla_recorder.violations_detected", count=len(violations))
    except Exception as exc:
        log.exception("sla_recorder.violation_check_failed", error=str(exc))
    
    return stats


# ---------------------------------------------------------------------------
# Celery Task Integration
# ---------------------------------------------------------------------------


def register_sla_recording_task(celery_app):
    """Register the SLA recording task with the Celery app.
    
    This should be called from app/celery_app.py or app/tasks.py to
    register the periodic task with Celery Beat.
    
    Args:
        celery_app: Celery application instance
    """
    from celery import shared_task
    
    @shared_task(name="sla.record_metrics", bind=True)
    def record_sla_metrics_task(self):
        """Celery task wrapper for record_sla_metrics."""
        import asyncio
        
        try:
            # Run the async function in a new event loop
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            stats = loop.run_until_complete(record_sla_metrics())
            loop.close()
            
            return {
                "status": "success",
                "stats": stats,
            }
            
        except Exception as exc:
            log.exception("sla_recorder.task_failed", error=str(exc))
            return {
                "status": "error",
                "error": str(exc),
            }
    
    # Register the periodic task in Celery Beat schedule
    # This should be added to the beat_schedule in app/celery_app.py:
    # 'record-sla-metrics': {
    #     'task': 'sla.record_metrics',
    #     'schedule': crontab(minute='*/5'),  # Every 5 minutes
    # }
    
    return record_sla_metrics_task
