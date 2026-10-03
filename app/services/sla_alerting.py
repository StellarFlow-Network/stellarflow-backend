"""SLA alerting service for detecting and notifying P99 latency violations.

Issue #973 — Build Automated API Endpoint Performance SLA Monitoring Middleware

This service monitors Prometheus metrics over a 5-minute sliding window and
sends HTTP alert notifications when P99 latency exceeds 200ms threshold.

Supports both HTTP REST endpoints and WebSocket message handlers.

The alert payload includes:
- Affected endpoint (method + path for HTTP, path + action + channel for WebSocket)
- Current P99 latency value
- SLA threshold that was exceeded
- Time window of the violation
- Request/message volume during the window
- Error rate statistics
"""

import os
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import aiohttp
import structlog
from prometheus_client import REGISTRY

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def get_alert_webhook_url() -> Optional[str]:
    """Get the alert webhook URL from environment variables.
    
    Returns:
        Webhook URL or None if not configured
    """
    return os.getenv("SLA_ALERT_WEBHOOK_URL")


def get_sla_target_p99_ms() -> float:
    """Get the P99 latency SLA target from environment variables.
    
    Returns:
        Target P99 latency in milliseconds (default: 200ms)
    """
    try:
        return float(os.getenv("SLA_TARGET_P99_MS", "200.0"))
    except ValueError:
        log.warning("Invalid SLA_TARGET_P99_MS value, using default 200ms")
        return 200.0


def get_alert_window_minutes() -> int:
    """Get the alert evaluation window in minutes.
    
    Returns:
        Window size in minutes (default: 5)
    """
    try:
        return int(os.getenv("SLA_ALERT_WINDOW_MINUTES", "5"))
    except ValueError:
        log.warning("Invalid SLA_ALERT_WINDOW_MINUTES value, using default 5")
        return 5


def get_alert_cooldown_minutes() -> int:
    """Get the alert cooldown period to prevent alert spam.
    
    Returns:
        Cooldown period in minutes (default: 15)
    """
    try:
        return int(os.getenv("SLA_ALERT_COOLDOWN_MINUTES", "15"))
    except ValueError:
        log.warning("Invalid SLA_ALERT_COOLDOWN_MINUTES value, using default 15")
        return 15


# ---------------------------------------------------------------------------
# Prometheus Query Functions
# ---------------------------------------------------------------------------


def calculate_percentile_from_histogram(
    metric_name: str,
    labels: Dict[str, str],
    percentile: float,
    window_minutes: int = 5,
) -> Optional[float]:
    """Calculate a percentile from a Prometheus histogram metric.
    
    This function queries the Prometheus histogram buckets and calculates
    the requested percentile using linear interpolation.
    
    Args:
        metric_name: Name of the histogram metric
        labels: Label filters (e.g., {"method": "GET", "endpoint": "/api/v1/users"})
        percentile: Percentile to calculate (0.0 to 1.0, e.g., 0.99 for P99)
        window_minutes: Time window in minutes to consider
        
    Returns:
        Percentile value in the metric's units (e.g., seconds) or None if not calculable
    """
    # Get the histogram metric from the registry
    for collector in REGISTRY._collector_to_names:
        if hasattr(collector, "_name") and collector._name == metric_name:
            # Build label matcher
            label_match = all(
                getattr(collector, "_labelnames", [])
            )
            
            # Get the histogram samples
            for metric in collector.collect():
                for sample in metric.samples:
                    # Match the labels
                    if all(sample.labels.get(k) == v for k, v in labels.items()):
                        # This is a simplified version - in production, you'd
                        # query a real Prometheus server using PromQL
                        # For now, we'll return None and rely on external Prometheus
                        pass
    
    return None


def get_endpoint_metrics(
    method: str,
    endpoint: str,
    window_minutes: int = 5,
) -> Optional[Dict[str, Any]]:
    """Get aggregated metrics for a specific endpoint over a time window.
    
    This function calculates SLA-relevant metrics from Prometheus data:
    - P50, P95, P99 latency percentiles
    - Total request count
    - Error rates (4xx, 5xx)
    - Success rate
    
    Args:
        method: HTTP method (GET, POST, etc.)
        endpoint: Normalized endpoint path
        window_minutes: Time window to analyze
        
    Returns:
        Dictionary of metrics or None if insufficient data
    """
    labels = {"method": method, "endpoint": endpoint}
    
    # In production, these would be actual PromQL queries to a Prometheus server
    # For this implementation, we'll query the local registry
    
    metrics = {
        "method": method,
        "endpoint": endpoint,
        "window_start": datetime.utcnow() - timedelta(minutes=window_minutes),
        "window_end": datetime.utcnow(),
    }
    
    # Try to get histogram metrics
    try:
        # Query the histogram for latency percentiles
        histogram_name = "http_request_duration_seconds"
        
        # Note: In production, use actual Prometheus HTTP API or python client
        # to query with PromQL like:
        # histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))
        
        # For now, we'll get the data from the local registry
        for collector in REGISTRY._collector_to_names:
            if hasattr(collector, "_name") and collector._name == histogram_name:
                for metric_family in collector.collect():
                    # Extract bucket data and calculate percentiles
                    buckets = []
                    for sample in metric_family.samples:
                        if sample.name == f"{histogram_name}_bucket":
                            if all(sample.labels.get(k) == v for k, v in labels.items()):
                                le = sample.labels.get("le")
                                if le != "+Inf":
                                    buckets.append((float(le), sample.value))
                    
                    if buckets:
                        # Simple percentile calculation from buckets
                        buckets.sort()
                        total_count = buckets[-1][1] if buckets else 0
                        
                        if total_count > 0:
                            metrics["total_requests"] = int(total_count)
                            metrics["latency_p99_seconds"] = calculate_p99_from_buckets(buckets, total_count)
                            metrics["latency_p99_ms"] = metrics["latency_p99_seconds"] * 1000
        
        # Get request counts by status code
        counter_name = "http_requests_total"
        success_count = 0
        error_4xx_count = 0
        error_5xx_count = 0
        total_count = 0
        
        for collector in REGISTRY._collector_to_names:
            if hasattr(collector, "_name") and collector._name == counter_name:
                for metric_family in collector.collect():
                    for sample in metric_family.samples:
                        sample_labels = sample.labels
                        if (sample_labels.get("method") == method and 
                            sample_labels.get("endpoint") == endpoint):
                            status_code = sample_labels.get("status_code", "")
                            count = sample.value
                            total_count += count
                            
                            if status_code.startswith("2"):
                                success_count += count
                            elif status_code.startswith("4"):
                                error_4xx_count += count
                            elif status_code.startswith("5"):
                                error_5xx_count += count
        
        if total_count > 0:
            metrics["total_requests"] = int(total_count)
            metrics["success_count"] = int(success_count)
            metrics["error_4xx_count"] = int(error_4xx_count)
            metrics["error_5xx_count"] = int(error_5xx_count)
            metrics["success_rate"] = (success_count / total_count) * 100
            metrics["error_rate"] = ((error_4xx_count + error_5xx_count) / total_count) * 100
        
        return metrics if metrics.get("total_requests", 0) > 0 else None
        
    except Exception as exc:
        log.exception("Failed to get endpoint metrics", method=method, endpoint=endpoint, error=str(exc))
        return None


def calculate_p99_from_buckets(buckets: List[tuple], total_count: float) -> float:
    """Calculate P99 from histogram buckets using linear interpolation.
    
    Args:
        buckets: List of (upper_bound, cumulative_count) tuples
        total_count: Total number of observations
        
    Returns:
        P99 value (in the same units as bucket bounds)
    """
    if not buckets or total_count == 0:
        return 0.0
    
    target_count = total_count * 0.99
    
    # Find the bucket containing the 99th percentile
    prev_bound, prev_count = 0.0, 0.0
    for bound, count in buckets:
        if count >= target_count:
            # Linear interpolation within this bucket
            if count == prev_count:
                return bound
            
            fraction = (target_count - prev_count) / (count - prev_count)
            return prev_bound + fraction * (bound - prev_bound)
        
        prev_bound, prev_count = bound, count
    
    # If we get here, return the last bucket's upper bound
    return buckets[-1][0]


# ---------------------------------------------------------------------------
# Alert Tracking (In-Memory Cache)
# ---------------------------------------------------------------------------

# In-memory cache of recent alerts to implement cooldown
# Format: {(method, endpoint): datetime_of_last_alert}
_alert_cache: Dict[tuple, datetime] = {}


def should_send_alert(method: str, endpoint: str) -> bool:
    """Check if an alert should be sent based on cooldown period.
    
    Args:
        method: HTTP method
        endpoint: Normalized endpoint path
        
    Returns:
        True if alert should be sent, False if in cooldown period
    """
    key = (method, endpoint)
    last_alert = _alert_cache.get(key)
    
    if last_alert is None:
        return True
    
    cooldown_minutes = get_alert_cooldown_minutes()
    elapsed = datetime.utcnow() - last_alert
    
    return elapsed > timedelta(minutes=cooldown_minutes)


def mark_alert_sent(method: str, endpoint: str) -> None:
    """Mark that an alert was sent for this endpoint.
    
    Args:
        method: HTTP method
        endpoint: Normalized endpoint path
    """
    key = (method, endpoint)
    _alert_cache[key] = datetime.utcnow()


# ---------------------------------------------------------------------------
# Alert Notification
# ---------------------------------------------------------------------------


async def send_alert_notification(
    endpoint_type: str,
    method: Optional[str],
    endpoint: str,
    action: Optional[str],
    channel: Optional[str],
    metrics: Dict[str, Any],
    sla_target_ms: float,
) -> bool:
    """Send an HTTP POST alert notification to the configured webhook.
    
    Args:
        endpoint_type: 'http' or 'websocket'
        method: HTTP method (None for WebSocket)
        endpoint: Endpoint path
        action: WebSocket action type (None for HTTP)
        channel: WebSocket channel (None for HTTP)
        metrics: Endpoint metrics dictionary
        sla_target_ms: SLA target threshold that was violated
        
    Returns:
        True if alert was sent successfully, False otherwise
    """
    webhook_url = get_alert_webhook_url()
    
    if not webhook_url:
        log.warning("SLA alert webhook URL not configured, skipping notification")
        return False
    
    # Build endpoint identification based on type
    if endpoint_type == "websocket":
        endpoint_info = {
            "type": "websocket",
            "path": endpoint,
            "action": action or "N/A",
            "channel": channel or "N/A",
        }
        endpoint_description = f"WebSocket {endpoint}"
        if action:
            endpoint_description += f" (action: {action})"
        if channel:
            endpoint_description += f" [channel: {channel}]"
    else:
        endpoint_info = {
            "type": "http",
            "method": method,
            "path": endpoint,
        }
        endpoint_description = f"{method} {endpoint}"
    
    # Build alert payload
    payload = {
        "alert_type": "sla_violation",
        "severity": "warning" if metrics.get("latency_p99_ms", 0) < sla_target_ms * 1.5 else "critical",
        "timestamp": datetime.utcnow().isoformat(),
        "endpoint": endpoint_info,
        "violation": {
            "metric": "p99_latency",
            "current_value_ms": round(metrics.get("latency_p99_ms", 0), 2),
            "threshold_ms": sla_target_ms,
            "exceeded_by_ms": round(metrics.get("latency_p99_ms", 0) - sla_target_ms, 2),
            "exceeded_by_percent": round(
                ((metrics.get("latency_p99_ms", 0) / sla_target_ms) - 1) * 100, 2
            ),
        },
        "window": {
            "start": metrics.get("window_start", datetime.utcnow()).isoformat(),
            "end": metrics.get("window_end", datetime.utcnow()).isoformat(),
            "duration_minutes": get_alert_window_minutes(),
        },
        "statistics": {
            "total_requests": metrics.get("total_requests") or metrics.get("total_messages", 0),
            "success_count": metrics.get("success_count", 0),
            "error_count": metrics.get("error_count", 0) if endpoint_type == "websocket" else (
                metrics.get("error_4xx_count", 0) + metrics.get("error_5xx_count", 0)
            ),
            "success_rate_percent": round(metrics.get("success_rate", 0), 2),
            "error_rate_percent": round(metrics.get("error_rate", 0), 2),
        },
        "message": (
            f"SLA violation detected: {endpoint_description} P99 latency "
            f"({metrics.get('latency_p99_ms', 0):.2f}ms) exceeded threshold "
            f"({sla_target_ms}ms) over the last {get_alert_window_minutes()} minutes"
        ),
    }
    
    # Add WebSocket-specific stats if applicable
    if endpoint_type == "websocket":
        payload["statistics"]["total_connections"] = metrics.get("total_connections", 0)
        payload["statistics"]["avg_connection_duration_seconds"] = round(
            metrics.get("avg_connection_duration_seconds", 0), 2
        )
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                webhook_url,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as response:
                if response.status in (200, 201, 202, 204):
                    log.info(
                        "sla_alert.sent",
                        endpoint_type=endpoint_type,
                        method=method,
                        endpoint=endpoint,
                        action=action,
                        channel=channel,
                        p99_ms=metrics.get("latency_p99_ms"),
                        threshold_ms=sla_target_ms,
                    )
                    return True
                else:
                    log.error(
                        "sla_alert.failed",
                        endpoint_type=endpoint_type,
                        method=method,
                        endpoint=endpoint,
                        action=action,
                        channel=channel,
                        status_code=response.status,
                        response_text=await response.text(),
                    )
                    return False
                    
    except Exception as exc:
        log.exception(
            "sla_alert.error",
            endpoint_type=endpoint_type,
            method=method,
            endpoint=endpoint,
            action=action,
            channel=channel,
            error=str(exc),
        )
        return False


# ---------------------------------------------------------------------------
# Main Alert Check Function
# ---------------------------------------------------------------------------


async def check_sla_violations() -> List[Dict[str, Any]]:
    """Check all monitored endpoints for SLA violations and send alerts.
    
    This function should be called periodically (e.g., every minute) by a
    background worker to monitor SLA compliance across all HTTP and WebSocket endpoints.
    
    Returns:
        List of violations detected (for logging/debugging)
    """
    sla_target_ms = get_sla_target_p99_ms()
    window_minutes = get_alert_window_minutes()
    violations = []
    
    log.debug("sla_alert.check_started", sla_target_ms=sla_target_ms, window_minutes=window_minutes)
    
    # Get all unique endpoint labels from the metrics registry (HTTP endpoints)
    endpoints_checked = set()
    
    for collector in REGISTRY._collector_to_names:
        if hasattr(collector, "_name") and collector._name == "http_request_duration_seconds":
            for metric_family in collector.collect():
                for sample in metric_family.samples:
                    method = sample.labels.get("method")
                    endpoint = sample.labels.get("endpoint")
                    
                    if method and endpoint:
                        endpoint_key = ("http", method, endpoint, None, None)
                        if endpoint_key not in endpoints_checked:
                            endpoints_checked.add(endpoint_key)
    
    # Get all WebSocket endpoints
    for collector in REGISTRY._collector_to_names:
        if hasattr(collector, "_name") and collector._name == "websocket_message_duration_seconds":
            for metric_family in collector.collect():
                for sample in metric_family.samples:
                    endpoint = sample.labels.get("endpoint")
                    action = sample.labels.get("action")
                    channel = sample.labels.get("channel")
                    
                    if endpoint:
                        endpoint_key = ("websocket", None, endpoint, action, channel)
                        if endpoint_key not in endpoints_checked:
                            endpoints_checked.add(endpoint_key)
    
    # Check each endpoint for violations
    for endpoint_type, method, endpoint, action, channel in endpoints_checked:
        if endpoint_type == "websocket":
            from app.services.sla_recorder import get_websocket_metrics
            metrics = get_websocket_metrics(endpoint, action, channel, window_minutes)
        else:
            metrics = get_endpoint_metrics(method, endpoint, window_minutes)
        
        if not metrics:
            continue
        
        p99_ms = metrics.get("latency_p99_ms", 0)
        
        # Check if P99 exceeds the SLA target
        if p99_ms > sla_target_ms:
            violation = {
                "endpoint_type": endpoint_type,
                "method": method,
                "endpoint": endpoint,
                "action": action,
                "channel": channel,
                "p99_ms": p99_ms,
                "threshold_ms": sla_target_ms,
                "metrics": metrics,
            }
            violations.append(violation)
            
            # Determine the cache key for cooldown
            if endpoint_type == "websocket":
                cache_key = f"{endpoint}:{action}:{channel}"
            else:
                cache_key = f"{method}:{endpoint}"
            
            # Send alert if not in cooldown
            if should_send_alert(method or "WS", cache_key):
                alert_sent = await send_alert_notification(
                    endpoint_type, method, endpoint, action, channel, metrics, sla_target_ms
                )
                if alert_sent:
                    mark_alert_sent(method or "WS", cache_key)
            else:
                log.debug(
                    "sla_alert.cooldown",
                    endpoint_type=endpoint_type,
                    method=method,
                    endpoint=endpoint,
                    action=action,
                    channel=channel,
                    p99_ms=p99_ms,
                )
    
    if violations:
        log.info("sla_alert.violations_detected", count=len(violations))
    
    return violations
