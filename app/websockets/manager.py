"""WebSocket connection management with binary Protocol Buffer support.

This module provides two connection managers:
1. ConnectionManager - JSON-based messaging (existing compatibility)
2. BinaryConnectionManager - Protocol Buffer binary messaging (optimized)
"""

import asyncio
import json
import logging
from typing import Dict, Set, Optional
from fastapi import WebSocket, WebSocketDisconnect
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

HEARTBEAT_INTERVAL = 30  # seconds


class ConnectionManager:
    """JSON-based WebSocket connection manager (legacy/compatible mode)."""
    
    def __init__(self, redis_url: str = "redis://localhost:6379"):
        self.redis_url = redis_url
        # Mapping: channel_name -> Set of active WebSockets
        self.subscriptions: Dict[str, Set[WebSocket]] = {}
        # Mapping: WebSocket -> Set of subscribed channel names
        self.client_channels: Dict[WebSocket, Set[str]] = {}
        self.redis: Optional[aioredis.Redis] = None
        self.pubsub: Optional[aioredis.PubSub] = None
        self._listener_task: Optional[asyncio.Task] = None

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


class BinaryConnectionManager:
    """Binary Protocol Buffer WebSocket connection manager (optimized mode).
    
    This manager handles binary protobuf messages instead of JSON,
    providing significantly reduced bandwidth and faster parsing.
    """
    
    def __init__(self, redis_url: str = "redis://localhost:6379"):
        self.redis_url = redis_url
        # Mapping: channel_name -> Set of active WebSockets
        self.subscriptions: Dict[str, Set[WebSocket]] = {}
        # Mapping: WebSocket -> Set of subscribed channel names
        self.client_channels: Dict[WebSocket, Set[str]] = {}
        self.redis: Optional[aioredis.Redis] = None
        self.pubsub: Optional[aioredis.PubSub] = None
        self._listener_task: Optional[asyncio.Task] = None
        # Statistics tracking
        self._message_count = 0
        self._bytes_sent = 0

    async def startup(self):
        """Initialize Redis connection and start Pub/Sub listener."""
        # Use decode_responses=False for binary data
        self.redis = aioredis.from_url(self.redis_url, decode_responses=False)
        self.pubsub = self.redis.pubsub()
        self._listener_task = asyncio.create_task(self._redis_pubsub_listener())
        logger.info("Binary WebSocket ConnectionManager initialized with Redis Pub/Sub.")

    async def shutdown(self):
        """Clean up tasks and Redis connections."""
        if self._listener_task:
            self._listener_task.cancel()
        if self.pubsub:
            await self.pubsub.close()
        if self.redis:
            await self.redis.close()
        
        logger.info(
            f"Binary ConnectionManager shutdown. "
            f"Messages sent: {self._message_count}, "
            f"Total bytes: {self._bytes_sent}"
        )

    async def connect(self, websocket: WebSocket):
        """Accept connection and initialize client tracking."""
        await websocket.accept()
        self.client_channels[websocket] = set()
        logger.info(f"Binary WebSocket client connected: {id(websocket)}")

    def disconnect(self, websocket: WebSocket):
        """Clean up all channel subscriptions for a disconnected client."""
        if websocket in self.client_channels:
            subscribed_channels = list(self.client_channels[websocket])
            for channel in subscribed_channels:
                self.unsubscribe(websocket, channel)
            del self.client_channels[websocket]
            logger.info(f"Binary WebSocket client disconnected: {id(websocket)}")

    def subscribe(self, websocket: WebSocket, channel: str):
        """Subscribe client to a specific topic channel."""
        if channel not in self.subscriptions:
            self.subscriptions[channel] = set()
            # Subscribe Redis PubSub if new channel (convert to bytes)
            channel_bytes = channel.encode('utf-8')
            asyncio.create_task(self.pubsub.subscribe(channel_bytes))

        self.subscriptions[channel].add(websocket)
        if websocket in self.client_channels:
            self.client_channels[websocket].add(channel)
        
        logger.debug(f"Client {id(websocket)} subscribed to channel: {channel}")

    def unsubscribe(self, websocket: WebSocket, channel: str):
        """Unsubscribe client from a topic channel."""
        if channel in self.subscriptions:
            self.subscriptions[channel].discard(websocket)
            if not self.subscriptions[channel]:
                del self.subscriptions[channel]
                # Unsubscribe from Redis if no listeners remain
                channel_bytes = channel.encode('utf-8')
                asyncio.create_task(self.pubsub.unsubscribe(channel_bytes))

        if websocket in self.client_channels:
            self.client_channels[websocket].discard(channel)
        
        logger.debug(f"Client {id(websocket)} unsubscribed from channel: {channel}")

    async def broadcast_binary(self, channel: str, binary_data: bytes):
        """Send binary protobuf message to all clients on a channel.
        
        Args:
            channel: Channel name to broadcast to
            binary_data: Serialized protobuf message bytes
        """
        if channel in self.subscriptions:
            dead_sockets = set()
            
            for ws in self.subscriptions[channel]:
                try:
                    await ws.send_bytes(binary_data)
                    self._message_count += 1
                    self._bytes_sent += len(binary_data)
                except Exception as e:
                    logger.warning(
                        f"Error sending binary message to client on {channel}: {e}"
                    )
                    dead_sockets.add(ws)

            for ws in dead_sockets:
                self.disconnect(ws)

    async def _redis_pubsub_listener(self):
        """Background task reading Redis Pub/Sub binary messages and broadcasting."""
        while True:
            try:
                message = await self.pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
                if message and message.get(b"type") == b"message":
                    channel_bytes = message[b"channel"]
                    channel = channel_bytes.decode('utf-8')
                    binary_data = message[b"data"]
                    await self.broadcast_binary(channel, binary_data)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in binary Redis Pub/Sub listener: {e}")
                await asyncio.sleep(1)
    
    def get_stats(self) -> dict:
        """Get connection manager statistics."""
        return {
            "active_connections": len(self.client_channels),
            "active_channels": len(self.subscriptions),
            "messages_sent": self._message_count,
            "total_bytes_sent": self._bytes_sent,
            "avg_message_size": (
                self._bytes_sent / self._message_count if self._message_count > 0 else 0
            )
        }


async def handle_websocket_session(websocket: WebSocket, manager: ConnectionManager):
    """Handle JSON WebSocket session with heartbeat."""
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

            if action == "subscribe" and channel:
                manager.subscribe(websocket, channel)
                await websocket.send_json({"status": "subscribed", "channel": channel})

            elif action == "unsubscribe" and channel:
                manager.unsubscribe(websocket, channel)
                await websocket.send_json({"status": "unsubscribed", "channel": channel})

            elif action == "pong":
                # Heartbeat response received
                pass

    except (WebSocketDisconnect, Exception) as e:
        logger.debug(f"WebSocket session ended: {e}")
        manager.disconnect(websocket)
    finally:
        heartbeat_task.cancel()


async def handle_binary_websocket_session(
    websocket: WebSocket, 
    manager: BinaryConnectionManager
):
    """Handle binary Protocol Buffer WebSocket session with heartbeat.
    
    This handler expects binary protobuf messages from clients and sends
    binary protobuf responses.
    """
    await manager.connect(websocket)

    async def heartbeat():
        """Periodically send binary heartbeat every 30s."""
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL)
            try:
                # Import here to avoid circular dependencies
                from app.services.proto_serializer import create_heartbeat_message
                from datetime import datetime
                
                heartbeat_msg = create_heartbeat_message(datetime.utcnow())
                await websocket.send_bytes(heartbeat_msg)
            except Exception as e:
                logger.debug(f"Heartbeat failed: {e}")
                manager.disconnect(websocket)
                break

    heartbeat_task = asyncio.create_task(heartbeat())

    try:
        while True:
            # Receive binary protobuf message from client
            binary_data = await websocket.receive_bytes()
            
            # Parse subscription request
            from app.proto_generated import streaming_pb2
            
            try:
                request = streaming_pb2.SubscriptionRequest()
                request.ParseFromString(binary_data)
                
                if request.action == streaming_pb2.SubscriptionRequest.SUBSCRIBE:
                    for channel in request.channels:
                        manager.subscribe(websocket, channel)
                        # Send confirmation
                        from app.services.proto_serializer import (
                            create_subscription_confirm
                        )
                        confirm_msg = create_subscription_confirm(channel, True)
                        await websocket.send_bytes(confirm_msg)
                
                elif request.action == streaming_pb2.SubscriptionRequest.UNSUBSCRIBE:
                    for channel in request.channels:
                        manager.unsubscribe(websocket, channel)
                        # Send confirmation
                        from app.services.proto_serializer import (
                            create_subscription_confirm
                        )
                        confirm_msg = create_subscription_confirm(channel, False)
                        await websocket.send_bytes(confirm_msg)
                
                elif request.action == streaming_pb2.SubscriptionRequest.PING:
                    # Client heartbeat response - no action needed
                    pass
                    
            except Exception as e:
                logger.error(f"Error parsing binary message: {e}")
                # Send error message
                from app.services.proto_serializer import create_error_message
                error_msg = create_error_message("PARSE_ERROR", str(e))
                await websocket.send_bytes(error_msg)

    except (WebSocketDisconnect, Exception) as e:
        logger.debug(f"Binary WebSocket session ended: {e}")
        manager.disconnect(websocket)
    finally:
        heartbeat_task.cancel()
