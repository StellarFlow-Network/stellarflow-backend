"""Binary Protocol Buffer WebSocket streaming endpoints.

This module provides optimized WebSocket endpoints that use Protocol Buffers
for binary message serialization, reducing bandwidth usage by >50% compared
to JSON.

Endpoints:
    - ws://host/v1/stream/pb - Binary protobuf streaming
    - ws://host/v1/stream/json - JSON streaming (legacy compatibility)
"""

import logging
from fastapi import APIRouter, WebSocket
from app.websockets.manager import (
    BinaryConnectionManager,
    ConnectionManager,
    handle_binary_websocket_session,
    handle_websocket_session,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["streaming"])

# Global connection managers (initialized at startup)
binary_manager: BinaryConnectionManager = None
json_manager: ConnectionManager = None


async def init_streaming_managers(redis_url: str = "redis://localhost:6379"):
    """Initialize WebSocket connection managers.
    
    This should be called during application startup.
    
    Args:
        redis_url: Redis connection URL for pub/sub
    """
    global binary_manager, json_manager
    
    binary_manager = BinaryConnectionManager(redis_url=redis_url)
    await binary_manager.startup()
    
    json_manager = ConnectionManager(redis_url=redis_url)
    await json_manager.startup()
    
    logger.info("Streaming connection managers initialized")


async def shutdown_streaming_managers():
    """Shutdown WebSocket connection managers.
    
    This should be called during application shutdown.
    """
    global binary_manager, json_manager
    
    if binary_manager:
        await binary_manager.shutdown()
    
    if json_manager:
        await json_manager.shutdown()
    
    logger.info("Streaming connection managers shut down")


@router.websocket("/v1/stream/pb")
async def websocket_binary_stream(websocket: WebSocket):
    """Binary Protocol Buffer WebSocket streaming endpoint.
    
    This endpoint provides real-time market data updates using Protocol Buffers
    for efficient binary serialization.
    
    ## Connection Protocol
    
    1. Client connects to ws://host/v1/stream/pb
    2. Server accepts connection
    3. Client sends SubscriptionRequest (protobuf) to subscribe to channels
    4. Server sends StreamMessage (protobuf) with data updates
    5. Server sends periodic Heartbeat messages
    
    ## Subscription Channels
    
    - `trade:{pool_id}` - Real-time trade updates for a pool
    - `depth:{pool_id}` - Order book depth updates
    - `pricing:{pool_id}` - Pricing ticker updates
    - `pool_stats:{pool_id}` - Pool statistics
    - `pricing:all` - All pricing updates
    
    ## Message Format
    
    All messages are serialized Protocol Buffer messages (StreamMessage).
    See proto/streaming.proto for schema definitions.
    
    ## Example (Python client)
    
    ```python
    import websockets
    from app.proto_generated import streaming_pb2
    
    async with websockets.connect("ws://localhost:8000/v1/stream/pb") as ws:
        # Subscribe to XLM-USDC trades
        request = streaming_pb2.SubscriptionRequest()
        request.action = streaming_pb2.SubscriptionRequest.SUBSCRIBE
        request.channels.append("trade:XLM-USDC")
        
        await ws.send(request.SerializeToString())
        
        # Receive messages
        while True:
            binary_data = await ws.recv()
            msg = streaming_pb2.StreamMessage()
            msg.ParseFromString(binary_data)
            
            if msg.type == streaming_pb2.StreamMessage.MARKET_TRADE:
                trade = msg.market_trade
                print(f"Trade: {trade.price} @ {trade.amount}")
    ```
    
    ## Benefits
    
    - 50-70% smaller message size vs JSON
    - Faster parsing (binary format)
    - Type-safe schema-defined messages
    - Backward compatible schema evolution
    """
    if not binary_manager:
        logger.error("Binary connection manager not initialized")
        await websocket.close(code=1011, reason="Service not available")
        return
    
    await handle_binary_websocket_session(websocket, binary_manager)


@router.websocket("/v1/stream/json")
async def websocket_json_stream(websocket: WebSocket):
    """JSON WebSocket streaming endpoint (legacy compatibility).
    
    This endpoint provides the same real-time data as /v1/stream/pb but
    uses JSON encoding for compatibility with clients that don't support
    Protocol Buffers.
    
    ## Connection Protocol
    
    1. Client connects to ws://host/v1/stream/json
    2. Server accepts connection
    3. Client sends JSON message: `{"action": "subscribe", "channel": "trade:XLM-USDC"}`
    4. Server sends JSON messages with data updates
    5. Server sends periodic ping: `{"type": "ping"}`
    
    ## Subscription Channels
    
    Same channels as binary endpoint (see /v1/stream/pb documentation).
    
    ## Message Format
    
    ```json
    {
        "channel": "trade:XLM-USDC",
        "data": {
            "trade_id": "12345",
            "price": "0.125",
            "amount": "10000",
            "side": "buy",
            "timestamp": "2024-01-15T10:30:00Z"
        }
    }
    ```
    
    ## Note
    
    For production use, prefer the binary endpoint (/v1/stream/pb) for:
    - Lower bandwidth usage
    - Faster processing
    - Better type safety
    """
    if not json_manager:
        logger.error("JSON connection manager not initialized")
        await websocket.close(code=1011, reason="Service not available")
        return
    
    await handle_websocket_session(websocket, json_manager)


@router.get("/v1/stream/stats")
async def get_streaming_stats():
    """Get WebSocket streaming statistics.
    
    Returns metrics about active connections, message throughput,
    and bandwidth usage for both binary and JSON endpoints.
    """
    stats = {
        "binary": binary_manager.get_stats() if binary_manager else None,
        "json": {
            "active_connections": len(json_manager.client_channels) if json_manager else 0,
            "active_channels": len(json_manager.subscriptions) if json_manager else 0,
        }
    }
    
    return {"success": True, "data": stats}
