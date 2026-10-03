# WebSocket SLA Monitoring Integration Guide

**Issue #973** — WebSocket Support for Automated API Endpoint Performance SLA Monitoring

## Overview

This guide explains how to integrate WebSocket SLA monitoring into your existing WebSocket endpoints. The monitoring tracks:

- **Message handling latency**: Time from receive to response
- **Connection duration**: Time from connect to disconnect
- **Message throughput**: Messages per second by action type
- **Error rates**: Failed message handling, connection errors
- **Channel-specific metrics**: Per-channel performance tracking

## Quick Start

### Option 1: Use the Decorator (Recommended for New Endpoints)

```python
from fastapi import FastAPI, WebSocket
from app.middleware import monitor_websocket_handler

app = FastAPI()

@app.websocket("/ws/notifications")
@monitor_websocket_handler("/ws/notifications")
async def notifications_endpoint(websocket: WebSocket):
    await websocket.accept()
    while True:
        data = await websocket.receive_text()
        await websocket.send_text(f"Received: {data}")
```

### Option 2: Use Context Managers (Recommended for Existing Endpoints)

```python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from app.middleware import track_websocket_connection, track_websocket_message

app = FastAPI()

@app.websocket("/ws/chat")
async def chat_endpoint(websocket: WebSocket):
    # Track connection lifecycle
    async with track_websocket_connection("/ws/chat"):
        await websocket.accept()
        
        try:
            while True:
                message = await websocket.receive_text()
                
                # Track each message handling
                async with track_websocket_message(
                    endpoint="/ws/chat",
                    action="message",
                    channel="general"
                ) as tracker:
                    # Process message
                    response = await process_message(message)
                    await websocket.send_text(response)
                    tracker.set_status("success")
                    
        except WebSocketDisconnect:
            pass  # Connection cleanup handled by context manager
```

## Integrating with Existing Endpoints

### Step 1: Import Monitoring Utilities

```python
from app.middleware.websocket_sla_monitoring import (
    track_websocket_connection,
    track_websocket_message,
    monitor_websocket_handler,
)
```

### Step 2: Choose Your Integration Method

#### For Simple Endpoints: Use the Decorator

If your endpoint is a simple function, wrap it with `@monitor_websocket_handler`:

```python
@monitor_websocket_handler("/ws/live", sla_target_ms=200.0)
async def websocket_endpoint(websocket: WebSocket):
    # Your existing code here
    pass
```

#### For Complex Endpoints: Use Context Managers

For endpoints with multiple actions (subscribe/unsubscribe, different message types), use context managers for fine-grained tracking:

```python
async def handle_websocket_session(websocket: WebSocket):
    async with track_websocket_connection("/ws/live") as conn_tracker:
        await websocket.accept()
        
        try:
            while True:
                data = await websocket.receive_text()
                parsed = json.loads(data)
                action = parsed.get("action")
                channel = parsed.get("channel")
                
                # Track message size
                conn_tracker.record_message_size(len(data.encode()), direction="inbound")
                
                if action == "subscribe":
                    async with track_websocket_message(
                        endpoint="/ws/live",
                        action="subscribe",
                        channel=channel
                    ) as tracker:
                        manager.subscribe(websocket, channel)
                        await websocket.send_json({"status": "subscribed"})
                        tracker.set_status("success")
                
                elif action == "unsubscribe":
                    async with track_websocket_message(
                        endpoint="/ws/live",
                        action="unsubscribe",
                        channel=channel
                    ) as tracker:
                        manager.unsubscribe(websocket, channel)
                        await websocket.send_json({"status": "unsubscribed"})
                        tracker.set_status("success")
                        
        except WebSocketDisconnect:
            pass
```

## Integration Examples

### Example 1: Instrumented manager.py

See `src/websockets/manager_instrumented.py` for a complete example of instrumenting the Redis Pub/Sub WebSocket manager.

**Key changes:**
1. Import monitoring utilities
2. Wrap entire handler with `track_websocket_connection`
3. Wrap each action (subscribe/unsubscribe) with `track_websocket_message`
4. Set status explicitly: `tracker.set_status("success")` or let exceptions set "error"

**To enable:**
```python
# Before:
from src.websockets.manager import handle_websocket_session, manager

# After:
from src.websockets.manager_instrumented import handle_websocket_session, manager
```

### Example 2: Simple Echo Server

See `src/services/main_instrumented.py` for a simple ping/pong WebSocket with monitoring.

**Key features:**
- Connection tracking with duration metrics
- Per-action tracking (ping vs generic message)
- Message size recording (inbound/outbound)

## Monitoring Configuration

### SLA Target

Default P99 latency target is **200ms**. Override per-endpoint:

```python
async with track_websocket_message(
    endpoint="/ws/live",
    action="subscribe",
    channel="trades",
    sla_target_ms=100.0  # Stricter target for critical endpoints
) as tracker:
    # Handle message
    pass
```

### Action Types

Use descriptive action names to group related messages:

```python
# Good - clear action types
track_websocket_message(endpoint="/ws/live", action="subscribe", channel="prices")
track_websocket_message(endpoint="/ws/live", action="unsubscribe", channel="prices")
track_websocket_message(endpoint="/ws/live", action="publish", channel="trades")
track_websocket_message(endpoint="/ws/live", action="ping", channel="heartbeat")

# Avoid - too generic
track_websocket_message(endpoint="/ws/live", action="message", channel="default")
```

### Channel Naming

Use meaningful channel names that map to your pub/sub topics:

```python
# Good - maps to business domains
channel="trade_updates"
channel="price_ticker_BTC_USDC"
channel="notifications_user_123"

# Avoid - not useful for analytics
channel="channel1"
channel="default"
```

## Metrics Exposed

### Prometheus Metrics

All WebSocket metrics are exposed at `/metrics`:

```promql
# Message handling latency histogram
websocket_message_duration_seconds{endpoint="/ws/live", action="subscribe", channel="prices"}

# Message counter
websocket_messages_total{endpoint="/ws/live", action="subscribe", channel="prices", status="success"}

# Connection duration histogram
websocket_connection_duration_seconds{endpoint="/ws/live"}

# Active connections gauge
websocket_connections_active{endpoint="/ws/live"}

# Connection events counter
websocket_connections_total{endpoint="/ws/live", event="connect"}

# SLA violations counter
websocket_sla_violations_total{endpoint="/ws/live", action="subscribe", threshold_ms="200"}

# Message size histograms
websocket_message_size_bytes{endpoint="/ws/live", direction="inbound"}
websocket_message_size_bytes{endpoint="/ws/live", direction="outbound"}

# Errors counter
websocket_errors_total{endpoint="/ws/live", error_type="WebSocketDisconnect"}
```

### Database Records

Aggregated metrics are stored in `endpoint_sla_metrics` table:

```sql
SELECT * FROM endpoint_sla_metrics
WHERE endpoint_type = 'websocket'
  AND route_path = '/ws/live'
  AND websocket_action = 'subscribe'
  AND window_start >= NOW() - INTERVAL '1 hour'
ORDER BY window_start DESC;
```

## Alert Configuration

Alerts are sent when P99 latency exceeds threshold over a 5-minute window.

### WebSocket Alert Payload

```json
{
  "alert_type": "sla_violation",
  "severity": "warning",
  "timestamp": "2026-09-29T15:30:00.000000",
  "endpoint": {
    "type": "websocket",
    "path": "/ws/live",
    "action": "subscribe",
    "channel": "trade_updates"
  },
  "violation": {
    "metric": "p99_latency",
    "current_value_ms": 245.67,
    "threshold_ms": 200.0,
    "exceeded_by_ms": 45.67,
    "exceeded_by_percent": 22.84
  },
  "window": {
    "start": "2026-09-29T15:25:00.000000",
    "end": "2026-09-29T15:30:00.000000",
    "duration_minutes": 5
  },
  "statistics": {
    "total_requests": 1523,
    "success_count": 1498,
    "error_count": 25,
    "success_rate_percent": 98.36,
    "error_rate_percent": 1.64,
    "total_connections": 142,
    "avg_connection_duration_seconds": 324.5
  },
  "message": "SLA violation detected: WebSocket /ws/live (action: subscribe) [channel: trade_updates] P99 latency (245.67ms) exceeded threshold (200ms) over the last 5 minutes"
}
```

## Best Practices

### 1. Track All Message Types

Don't just track user actions - track system messages too:

```python
# User actions
track_websocket_message(endpoint="/ws/live", action="subscribe", ...)
track_websocket_message(endpoint="/ws/live", action="unsubscribe", ...)

# System messages
track_websocket_message(endpoint="/ws/live", action="ping", channel="heartbeat")
track_websocket_message(endpoint="/ws/live", action="broadcast", channel=channel)
```

### 2. Set Status Explicitly

Always set the status when the operation succeeds:

```python
async with track_websocket_message(...) as tracker:
    try:
        await do_something()
        tracker.set_status("success")  # Explicit success
    except ValueError:
        tracker.set_status("rejected")  # Business logic rejection
    # Unhandled exceptions automatically set status="error"
```

### 3. Record Message Sizes

For bandwidth monitoring, record message sizes:

```python
async with track_websocket_connection("/ws/live") as conn_tracker:
    while True:
        data = await websocket.receive_text()
        conn_tracker.record_message_size(len(data.encode()), "inbound")
        
        response = await process(data)
        await websocket.send_text(response)
        conn_tracker.record_message_size(len(response.encode()), "outbound")
```

### 4. Use Consistent Endpoint Names

Use the same endpoint name across your application:

```python
# Good - consistent
ENDPOINT = "/ws/live"
track_websocket_connection(ENDPOINT)
track_websocket_message(endpoint=ENDPOINT, ...)

# Avoid - inconsistent
track_websocket_connection("/ws/live")
track_websocket_message(endpoint="ws/live", ...)  # Missing leading slash!
```

### 5. Don't Track Everything

Skip tracking for:
- Heartbeat pongs (client responses)
- Empty messages
- Messages that don't represent real work

```python
if action == "pong":
    # Don't track - this is just a heartbeat response
    pass
elif action == "subscribe":
    # Track - this is real work
    async with track_websocket_message(...):
        await handle_subscribe()
```

## Troubleshooting

### No Metrics Appearing

1. Check that monitoring is imported:
   ```python
   from app.middleware.websocket_sla_monitoring import track_websocket_message
   ```

2. Verify metrics endpoint:
   ```bash
   curl http://localhost:8000/metrics | grep websocket
   ```

3. Ensure messages are being tracked:
   ```python
   async with track_websocket_message(...) as tracker:
       # Code must be inside the context manager
       await handle_message()
   ```

### High Latency False Positives

If you see artificially high latency:

1. **Move I/O outside tracking**: Don't track the `receive` operation, only the processing:
   ```python
   # Bad - includes time waiting for next message
   async with track_websocket_message(...):
       data = await websocket.receive_text()  # Could wait seconds!
       await process(data)
   
   # Good - only tracks processing time
   data = await websocket.receive_text()
   async with track_websocket_message(...):
       await process(data)
   ```

2. **Check for blocking operations**: Use `await` for all I/O inside tracked sections

### Metrics Not in Database

1. Verify Celery beat is running:
   ```bash
   celery -A app.celery_app beat --loglevel=info
   ```

2. Check the migration was applied:
   ```bash
   alembic current
   ```

3. Look for errors in Celery worker logs:
   ```bash
   celery -A app.celery_app worker --loglevel=debug
   ```

## Migration Checklist

- [ ] Install dependencies: `pip install -r requirements.txt`
- [ ] Run migration: `alembic upgrade head`
- [ ] Import monitoring utilities in WebSocket handlers
- [ ] Add `track_websocket_connection` wrapper to connection lifecycle
- [ ] Add `track_websocket_message` to message handlers
- [ ] Set action types and channel names appropriately
- [ ] Test that metrics appear at `/metrics`
- [ ] Verify database records are created every 5 minutes
- [ ] Configure alert webhook URL
- [ ] Test alert notifications

## Reference Implementation

For a complete working example, see:
- `src/websockets/manager_instrumented.py` - Redis Pub/Sub manager with full monitoring
- `src/services/main_instrumented.py` - Simple echo server with monitoring

Both files are drop-in replacements with monitoring enabled.
