"""Instrumented WebSocket service with SLA monitoring.

Issue #973 — Build Automated API Endpoint Performance SLA Monitoring Middleware

This is an instrumented version of the WebSocket service that adds SLA monitoring
for the /ws/live endpoint.

Usage:
    Use this as a reference or replace src/services/main.py with this version.
"""

import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import redis.asyncio as redis

from app.middleware.websocket_sla_monitoring import (
    track_websocket_connection,
    track_websocket_message,
    monitor_websocket_handler,
)

app = FastAPI()
redis_client = redis.Redis(host='localhost', port=6379, decode_responses=True)


class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception:
                pass


manager = ConnectionManager()


async def redis_listener():
    pubsub = redis_client.pubsub()
    await pubsub.subscribe("trade_updates", "price_updates", "notifications")
    async for message in pubsub.listen():
        if message["type"] == "message":
            await manager.broadcast(message["data"])


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(redis_listener())


@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint with SLA monitoring.
    
    Tracks:
    - Connection duration
    - Message handling latency
    - Ping/pong response times
    """
    # Track the entire connection lifecycle
    async with track_websocket_connection("/ws/live") as conn_tracker:
        await manager.connect(websocket)
        
        try:
            while True:
                # Receive message
                data = await websocket.receive_text()
                
                # Track message size
                conn_tracker.record_message_size(len(data.encode()), direction="inbound")
                
                # Track message handling
                if data == "ping":
                    async with track_websocket_message(
                        endpoint="/ws/live",
                        action="ping",
                        channel="heartbeat",
                    ) as msg_tracker:
                        response = "pong"
                        await websocket.send_text(response)
                        msg_tracker.set_status("success")
                        
                        # Track response size
                        conn_tracker.record_message_size(len(response.encode()), direction="outbound")
                else:
                    # Generic message handling
                    async with track_websocket_message(
                        endpoint="/ws/live",
                        action="message",
                        channel="default",
                    ) as msg_tracker:
                        # Process message (echo back in this simple example)
                        await websocket.send_text(f"Echo: {data}")
                        msg_tracker.set_status("success")
                        
        except WebSocketDisconnect:
            manager.disconnect(websocket)
