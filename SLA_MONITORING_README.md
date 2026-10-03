# API Endpoint Performance SLA Monitoring

**Issue #973** — Automated API Endpoint Performance SLA Monitoring Middleware

## Overview

This system tracks P95 and P99 latency SLA targets across all public **REST and WebSocket routes**, provides real-time Prometheus metrics, sends HTTP alert notifications for violations, and records compliance scores in PostgreSQL for dashboard analytics.

### Supported Endpoint Types

- **HTTP/REST endpoints**: GET, POST, PUT, DELETE, PATCH requests
- **WebSocket endpoints**: Message handling, connection duration, pub/sub channels

## Architecture

### Components

1. **HTTP SLA Monitoring Middleware** (`app/middleware/sla_monitoring.py`)
   - Wraps every HTTP request
   - Tracks request duration, status codes, and payload sizes
   - Exposes Prometheus metrics for scraping
   - Logs slow requests in real-time

2. **WebSocket SLA Monitoring** (`app/middleware/websocket_sla_monitoring.py`)
   - Tracks WebSocket message handling latency
   - Monitors connection duration and lifecycle
   - Records message throughput by action type and channel
   - Provides context managers and decorators for easy integration
   - See [WEBSOCKET_SLA_INTEGRATION.md](WEBSOCKET_SLA_INTEGRATION.md) for integration guide

3. **Prometheus Metrics** (exposed at `/metrics`)
   - `http_request_duration_seconds`: Histogram with P50/P95/P99 latency percentiles
   - `http_requests_total`: Counter by endpoint, method, and status code
   - `http_requests_active`: Gauge of in-flight requests
   - `http_sla_violations_total`: Counter of SLA threshold violations
   - `http_request_size_bytes`: Request payload size histogram
   - `http_response_size_bytes`: Response payload size histogram
   - `websocket_message_duration_seconds`: WebSocket message handling latency histogram
   - `websocket_messages_total`: Counter by endpoint, action, channel, and status
   - `websocket_connections_active`: Gauge of active WebSocket connections
   - `websocket_connection_duration_seconds`: Connection lifetime histogram
   - `websocket_sla_violations_total`: Counter of WebSocket SLA violations
   - `websocket_message_size_bytes`: WebSocket message size histogram

4. **Alert Service** (`app/services/sla_alerting.py`)
   - Monitors P99 latency over 5-minute sliding windows
   - Sends HTTP webhook alerts when P99 > 200ms
   - Implements cooldown period to prevent alert spam
   - Includes detailed violation context (request/message volume, error rates, etc.)
   - Supports both HTTP and WebSocket endpoints

5. **Background Recorder** (`app/services/sla_recorder.py`)
   - Celery beat task running every 5 minutes
   - Aggregates Prometheus metrics per endpoint (HTTP and WebSocket)
   - Calculates compliance scores (0.0-1.0)
   - Writes records to `endpoint_sla_metrics` table
   - Cleans up records older than retention period

6. **Database Model** (`app/models/sla.py`)
   - `EndpointSLAMetric`: Stores time-series SLA data
   - Supports both `endpoint_type='http'` and `endpoint_type='websocket'`
   - WebSocket-specific fields: `websocket_action`, `websocket_channel`, `total_connections`, `avg_connection_duration_seconds`
   - Indexed for efficient dashboard queries
   - Supports partitioning by time window

## WebSocket Integration

For detailed instructions on integrating WebSocket SLA monitoring into your endpoints, see **[WEBSOCKET_SLA_INTEGRATION.md](WEBSOCKET_SLA_INTEGRATION.md)**.

**Quick Example:**
```python
from app.middleware import track_websocket_connection, track_websocket_message

@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    async with track_websocket_connection("/ws/live"):
        await websocket.accept()
        while True:
            data = await websocket.receive_text()
            async with track_websocket_message("/ws/live", "message", "default"):
                await websocket.send_text(f"Echo: {data}")
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SLA_TARGET_P99_MS` | `200.0` | Target P99 latency threshold in milliseconds |
| `SLA_ALERT_WEBHOOK_URL` | - | HTTP webhook URL for alert notifications |
| `SLA_ALERT_WINDOW_MINUTES` | `5` | Time window for P99 evaluation |
| `SLA_ALERT_COOLDOWN_MINUTES` | `15` | Minimum gap between alerts for same endpoint |
| `SLA_RECORDING_INTERVAL_MINUTES` | `5` | How often to record metrics to PostgreSQL |
| `SLA_RETENTION_DAYS` | `90` | How long to retain historical metrics |

### Example Configuration

```bash
# .env
SLA_TARGET_P99_MS=200.0
SLA_ALERT_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
SLA_ALERT_WINDOW_MINUTES=5
SLA_ALERT_COOLDOWN_MINUTES=15
SLA_RECORDING_INTERVAL_MINUTES=5
SLA_RETENTION_DAYS=90
```

## Deployment

### 1. Run Database Migration

```bash
# Apply the migration to create the endpoint_sla_metrics table
alembic upgrade head
```

### 2. Configure Prometheus

Add the `/metrics` endpoint to your Prometheus scrape configuration:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'stellarflow-backend'
    scrape_interval: 15s
    static_configs:
      - targets: ['backend:8000']
    metrics_path: '/metrics'
```

### 3. Start the Application

The middleware is automatically enabled when the FastAPI app starts:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### 4. Start Celery Workers

The SLA recording task requires Celery workers:

```bash
# Start Celery worker
celery -A app.celery_app worker --loglevel=info

# Start Celery beat scheduler
celery -A app.celery_app beat --loglevel=info
```

## Alert Notification Format

When P99 latency exceeds the threshold, the alert service sends an HTTP POST to the configured webhook URL:

```json
{
  "alert_type": "sla_violation",
  "severity": "warning",
  "timestamp": "2026-09-29T10:15:30.000000",
  "endpoint": {
    "method": "GET",
    "path": "/api/v1/users/{id}"
  },
  "violation": {
    "metric": "p99_latency",
    "current_value_ms": 245.67,
    "threshold_ms": 200.0,
    "exceeded_by_ms": 45.67,
    "exceeded_by_percent": 22.84
  },
  "window": {
    "start": "2026-09-29T10:10:00.000000",
    "end": "2026-09-29T10:15:00.000000",
    "duration_minutes": 5
  },
  "statistics": {
    "total_requests": 1523,
    "success_count": 1498,
    "error_4xx_count": 12,
    "error_5xx_count": 13,
    "success_rate_percent": 98.36,
    "error_rate_percent": 1.64
  },
  "message": "SLA violation detected: GET /api/v1/users/{id} P99 latency (245.67ms) exceeded threshold (200ms) over the last 5 minutes"
}
```

### Slack Webhook Integration

```bash
# Create a Slack Incoming Webhook:
# 1. Go to https://api.slack.com/apps
# 2. Create a new app or select an existing one
# 3. Enable Incoming Webhooks
# 4. Add the webhook URL to your .env file

SLA_ALERT_WEBHOOK_URL=https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXX
```

## Prometheus Query Examples

### P99 Latency by Endpoint

```promql
# P99 latency over the last 5 minutes
histogram_quantile(0.99, 
  rate(http_request_duration_seconds_bucket[5m])
)
```

### SLA Violation Rate

```promql
# Percentage of time windows with SLA violations
(
  sum(rate(http_sla_violations_total[5m])) /
  sum(rate(http_requests_total[5m]))
) * 100
```

### Request Rate by Endpoint

```promql
# Requests per second, grouped by endpoint
sum(rate(http_requests_total[1m])) by (endpoint, method)
```

### Error Rate by Endpoint

```promql
# 5xx error rate
sum(rate(http_requests_total{status_code=~"5.."}[5m])) by (endpoint)
/
sum(rate(http_requests_total[5m])) by (endpoint)
```

## Dashboard Queries

### Recent SLA Metrics

```sql
-- Get the last 24 hours of SLA metrics for a specific endpoint
SELECT 
  window_start,
  http_method,
  route_path,
  total_requests,
  latency_p99_ms,
  sla_compliant,
  compliance_score,
  success_rate,
  error_rate
FROM endpoint_sla_metrics
WHERE 
  route_path = '/api/v1/users/{id}'
  AND window_start >= NOW() - INTERVAL '24 hours'
ORDER BY window_start DESC;
```

### Endpoint Compliance Summary

```sql
-- Get compliance summary for all endpoints over the last 7 days
SELECT 
  http_method,
  route_path,
  COUNT(*) as total_windows,
  SUM(CASE WHEN sla_compliant THEN 1 ELSE 0 END) as compliant_windows,
  AVG(latency_p99_ms) as avg_p99_ms,
  MAX(latency_p99_ms) as max_p99_ms,
  AVG(compliance_score) as avg_compliance_score,
  SUM(total_requests) as total_requests
FROM endpoint_sla_metrics
WHERE window_start >= NOW() - INTERVAL '7 days'
GROUP BY http_method, route_path
ORDER BY avg_compliance_score ASC;
```

### SLA Violations

```sql
-- Get all SLA violations in the last 24 hours
SELECT 
  window_start,
  http_method,
  route_path,
  latency_p99_ms,
  sla_target_p99_ms,
  total_requests,
  alert_triggered,
  alert_sent_at
FROM endpoint_sla_metrics
WHERE 
  sla_compliant = false
  AND window_start >= NOW() - INTERVAL '24 hours'
ORDER BY latency_p99_ms DESC;
```

## Path Normalization

The middleware automatically normalizes endpoint paths to prevent metric cardinality explosion:

| Original Path | Normalized Path |
|---------------|-----------------|
| `/api/v1/users/12345` | `/api/v1/users/{id}` |
| `/api/v1/proofs/abc-def-123` | `/api/v1/proofs/{id}` |
| `/api/v1/tx/64hexchars...` | `/api/v1/tx/{hash}` |
| `/api/v1/accounts/GABC...` | `/api/v1/accounts/{address}` |

This ensures that similar endpoints are grouped together in metrics rather than creating a unique metric for each user ID, transaction hash, etc.

## Compliance Score Calculation

The compliance score (0.0 to 1.0) is a weighted combination of three factors:

- **Latency Compliance (50%)**: How well P99 stays within the SLA target
- **Availability (30%)**: Success rate (2xx responses)
- **Error Rate (20%)**: Inverse of error rate (lower is better)

### Formula

```python
latency_score = max(0, min(1, 2.0 - (p99_ms / target_ms)))
availability_score = success_count / total_requests
error_score = max(0, min(1, 1.0 - (error_rate / 50.0)))

compliance_score = (
    latency_score * 0.5 +
    availability_score * 0.3 +
    error_score * 0.2
)
```

### Score Interpretation

| Score Range | Interpretation |
|-------------|----------------|
| 0.95 - 1.00 | Excellent |
| 0.85 - 0.95 | Good |
| 0.70 - 0.85 | Fair |
| 0.50 - 0.70 | Poor |
| 0.00 - 0.50 | Critical |

## Troubleshooting

### No Metrics Appearing

1. Check that the middleware is properly registered:
   ```python
   app.add_middleware(SLAMonitoringMiddleware, sla_target_p99_ms=200.0)
   ```

2. Verify the `/metrics` endpoint is accessible:
   ```bash
   curl http://localhost:8000/metrics
   ```

3. Ensure Prometheus is scraping the endpoint (check Prometheus targets page)

### Alerts Not Triggering

1. Verify webhook URL is configured:
   ```bash
   echo $SLA_ALERT_WEBHOOK_URL
   ```

2. Check Celery worker logs for errors:
   ```bash
   celery -A app.celery_app worker --loglevel=debug
   ```

3. Test the webhook manually:
   ```bash
   curl -X POST $SLA_ALERT_WEBHOOK_URL \
     -H "Content-Type: application/json" \
     -d '{"text":"Test alert"}'
   ```

### Database Records Not Being Created

1. Verify the migration was applied:
   ```bash
   alembic current
   alembic history
   ```

2. Check Celery beat is running:
   ```bash
   celery -A app.celery_app beat --loglevel=info
   ```

3. Verify the task is scheduled:
   ```bash
   celery -A app.celery_app inspect scheduled
   ```

## Performance Impact

The SLA monitoring middleware adds minimal overhead:

- **Per-request overhead**: ~0.1-0.2ms (time.perf_counter() calls)
- **Memory overhead**: ~100KB (Prometheus metric storage)
- **CPU overhead**: Negligible (histogram bucket updates are O(1))

The middleware is designed to be fail-safe: exceptions in metric collection are caught and logged without affecting request handling.

## Best Practices

1. **Set Realistic SLA Targets**: Start with conservative targets (e.g., 500ms) and tighten them as your service stabilizes

2. **Monitor Prometheus Cardinality**: Keep an eye on the number of unique endpoint labels to avoid excessive memory usage

3. **Tune Alert Cooldown**: Adjust `SLA_ALERT_COOLDOWN_MINUTES` based on your incident response workflow

4. **Regular Data Cleanup**: The automatic cleanup runs with each recording task, but you can manually clean up old data:
   ```sql
   DELETE FROM endpoint_sla_metrics 
   WHERE window_start < NOW() - INTERVAL '90 days';
   ```

5. **Dashboard Integration**: Build Grafana dashboards using the Prometheus metrics for real-time monitoring

6. **Alert Routing**: Consider routing alerts to different channels based on severity (Slack for warnings, PagerDuty for critical)

## Related Issues

- Issue #760: OpenTelemetry APM Tracing
- Issue #782: Health Probe Timeout Configuration
- Issue #792: CORS & Security Headers

## References

- [Prometheus Python Client Documentation](https://prometheus.github.io/client_python/)
- [FastAPI Middleware Guide](https://fastapi.tiangolo.com/advanced/middleware/)
- [SLA Definition (Wikipedia)](https://en.wikipedia.org/wiki/Service-level_agreement)
