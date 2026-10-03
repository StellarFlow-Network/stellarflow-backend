"""Instrumented WebSocket manager with SLA monitoring.

Issue #973 — Build Automated API Endpoint Performance SLA Monitoring Middleware

This is an instrumented version of the WebSocket manager that adds SLA monitoring
to track message handling latency, connection duration, and error rates.

Usage:
    Replace imports from src.websockets.manager with this module to enable monitoring:
    
    # Before:
    from src.websockets.manager import handle_websocket_session, manager
    
    # After:
    from src.websockets.manager_instrumented import handle_websocket_session, manager
"""

import asyncio
import json
import logging
from typing import Dict, Set

from fastapi import WebSocket, WebSocketDisconnect
import redis.asyncio as aioredis

from app.middleware.websocket_sla_monitoring import (
    track_websocket_connection,
    track_websocket_message,
)

logger = logging.getLogger(__name__)

HEARTBEAT_INTERVAL = 30  # seconds


class ConnectionManager:
    """WebSocket connection manager with SLA monitoring integration."""
    
    def __init__(self, redis_url: str = "redis://localhost:6379"):
        self.redis_url = redis_url
        # Mapping: channel_name -> Set of active WebSockets
        self.subscriptions: Dict[str, Set[WebSocket]] = {}
        # Mapping: WebSocket -> Set of subscribed channel names
        self.client_channels: Dict[WebSocket, Set[str]] = {}
        self.redis: aioredis.Redis = None
        self.pubsub: aioredis.PubSub = None
        self._listener_task: asyncio.Task = None

    async def startup(self):
        """Initialize Redis connection and start Pub/Sub listener."""
        self.redis = aioredis.from_url(self.redis_url, decode_responses=True)
        self.pubsub = self.redis.pubsub()
        self._listener_task = asyncio.create_task(self._redis_pubsub_listener())
        logger.info("WebSocket ConnectionManager initialized with Redis Pub/Sub.")

    async def shutdown(self):
        """Clean up tasks and Redis connections."""
        if self._listener_task:
            self._listener_task.cancel()
        if self.pubsub:
            await self.pubsub.close()
        if self.redis:
            await self.redis.close()

    async def connect(self, websocket: WebSocket):
        """Accept connection and initialize client tracking."""
        await websocket.accept()
        self.client_channels[websocket] = set()

    def disconnect(self, websocket: WebSocket):
        """Clean up all channel subscriptions for a disconnected client."""
        if websocket in self.client_channels:
            subscribed_channels = list(self.client_channels[websocket])
            for channel in subscribed_channels:
                self.unsubscribe(websocket, channel)
            del self.client_channels[websocket]

    def subscribe(self, websocket: WebSocket, channel: str):
        """Subscribe client to a specific topic channel."""
        if channel not in self.subscriptions:
            self.subscriptions[channel] = set()
            # Subscribe Redis PubSub if new channel
            asyncio.create_task(self.pubsub.subscribe(channel))

        self.subscriptions[channel].add(websocket)
        if websocket in self.client_channels:
            self.client_channels[websocket].add(channel)

    def unsubscribe(self, websocket: WebSocket, channel: str):
        """Unsubscribe client from a topic channel."""
        if channel in self.subscriptions:
            self.subscriptions[channel].discard(websocket)
            if not self.subscriptions[channel]:
                del self.subscriptions[channel]
                # Unsubscribe from Redis if no listeners remain
                asyncio.create_task(self.pubsub.unsubscribe(channel))

        if websocket in self.client_channels:
            self.client_channels[websocket].discard(channel)

    async def broadcast_to_channel(self, channel: str, message: dict):
        """Send message payload to all local WebSocket clients on a channel."""
        if channel in self.subscriptions:
            dead_sockets = set()
            payload = json.dumps({"channel": channel, "data": message})

            for ws in self.subscriptions[channel]:
                try:
                    await ws.send_text(payload)
                except Exception as e:
                    logger.warning(f"Error sending message to client on {channel}: {e}")
                    dead_sockets.add(ws)

            for ws in dead_sockets:
                self.disconnect(ws)

    async def _redis_pubsub_listener(self):
        """Background task reading Redis Pub/Sub messages and broadcasting."""
        while True:
            try:
                message = await self.pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if message and message.get("type") == "message":
                    channel = message["channel"]
                    data = json.loads(message["data"])
                    await self.broadcast_to_channel(channel, data)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in Redis Pub/Sub listener: {e}")
                await asyncio.sleep(1)


manager = ConnectionManager()


async def handle_websocket_session(websocket: WebSocket):
    """Handles client incoming actions and 30s heartbeat check with SLA monitoring.
    
    This instrumented version tracks:
    - Connection lifecycle (connect/disconnect)
    - Message handling latency per action type
    - Channel-specific metrics
    - Error rates
    """
    # Track the entire connection lifecycle
    async with track_websocket_connection("/ws/live"):
        await manager.connect(websocket)

        async def heartbeat():
            """Periodically ping client every 30s to drop stale connections."""
            while True:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    manager.disconnect(websocket)
                    break

        heartbeat_task = asyncio.create_task(heartbeat())

        try:
            while True:
                data_text = await websocket.receive_text()
                data = json.loads(data_text)
                action = data.get("action")
                channel = data.get("channel")

                # Track message handling with action-specific metrics
                if action == "subscribe" and channel:
                    async with track_websocket_message(
                        endpoint="/ws/live",
                        action="subscribe",
                        channel=channel,
                    ) as tracker:
                        manager.subscribe(websocket, channel)
                        await websocket.send_json({"status": "subscribed", "channel": channel})
                        tracker.set_status("success")

                elif action == "unsubscribe" and channel:
                    async with track_websocket_message(
                        endpoint="/ws/live",
                        action="unsubscribe",
                        channel=channel,
                    ) as tracker:
                        manager.unsubscribe(websocket, channel)
                        await websocket.send_json({"status": "unsubscribed", "channel": channel})
                        tracker.set_status("success")

                elif action == "pong":
                    # Heartbeat response - don't track latency for pongs
                    pass
                else:
                    # Unknown action - track as generic message
                    async with track_websocket_message(
                        endpoint="/ws/live",
                        action="unknown",
                        channel=channel or "none",
                    ) as tracker:
                        logger.warning(f"Unknown WebSocket action: {action}")
                        tracker.set_status("error")

        except (WebSocketDisconnect, Exception):
            manager.disconnect(websocket)
        finally:
            heartbeat_task.cancel()
