"""Protocol Buffer serialization service.

This module provides helper functions for creating and serializing
Protocol Buffer messages for WebSocket streaming.
"""

from datetime import datetime
from typing import List, Dict, Any, Optional
from decimal import Decimal

# Import will work after proto compilation
try:
    from app.proto_generated import streaming_pb2
    PROTOBUF_AVAILABLE = True
except ImportError:
    PROTOBUF_AVAILABLE = False
    streaming_pb2 = None


def _datetime_to_timestamp(dt: datetime) -> "streaming_pb2.Timestamp":
    """Convert Python datetime to protobuf Timestamp."""
    timestamp = streaming_pb2.Timestamp()
    timestamp.seconds = int(dt.timestamp())
    timestamp.nanos = dt.microsecond * 1000
    return timestamp


def _decimal_to_string(value: Any) -> str:
    """Convert Decimal or numeric value to string for protobuf."""
    if isinstance(value, Decimal):
        return str(value)
    elif isinstance(value, (int, float)):
        return str(value)
    return value


def create_market_trade_message(
    trade_id: str,
    pool_id: str,
    base_asset: str,
    quote_asset: str,
    price: Any,
    amount: Any,
    side: str,
    timestamp: datetime,
    sequence: int,
    channel: str = None
) -> bytes:
    """Create a serialized MarketTrade message.
    
    Args:
        trade_id: Unique trade identifier
        pool_id: Trading pool identifier (e.g., "XLM-USDC")
        base_asset: Base asset code
        quote_asset: Quote asset code
        price: Trade price (Decimal, float, or string)
        amount: Trade amount (Decimal, float, or string)
        side: Trade side ("buy" or "sell")
        timestamp: Trade timestamp
        sequence: Sequence number for ordering
        channel: Optional channel name (defaults to "trade:{pool_id}")
    
    Returns:
        Serialized binary protobuf message
    """
    if not PROTOBUF_AVAILABLE:
        raise ImportError("Protocol Buffer modules not available. Run: python scripts/compile_proto.py")
    
    # Create trade message
    trade = streaming_pb2.MarketTrade()
    trade.trade_id = trade_id
    trade.pool_id = pool_id
    trade.base_asset = base_asset
    trade.quote_asset = quote_asset
    trade.price = _decimal_to_string(price)
    trade.amount = _decimal_to_string(amount)
    trade.side = side
    trade.timestamp.CopyFrom(_datetime_to_timestamp(timestamp))
    trade.sequence = sequence
    
    # Wrap in StreamMessage envelope
    stream_msg = streaming_pb2.StreamMessage()
    stream_msg.type = streaming_pb2.StreamMessage.MARKET_TRADE
    stream_msg.channel = channel or f"trade:{pool_id}"
    stream_msg.market_trade.CopyFrom(trade)
    
    return stream_msg.SerializeToString()


def create_order_book_depth_message(
    pool_id: str,
    base_asset: str,
    quote_asset: str,
    bids: List[Dict[str, Any]],
    asks: List[Dict[str, Any]],
    timestamp: datetime,
    sequence: int,
    is_snapshot: bool = False,
    channel: str = None
) -> bytes:
    """Create a serialized OrderBookDepth message.
    
    Args:
        pool_id: Trading pool identifier
        base_asset: Base asset code
        quote_asset: Quote asset code
        bids: List of bid levels [{"price": "0.125", "amount": "10000", "order_count": 5}, ...]
        asks: List of ask levels
        timestamp: Update timestamp
        sequence: Sequence number
        is_snapshot: True for full snapshot, False for incremental update
        channel: Optional channel name (defaults to "depth:{pool_id}")
    
    Returns:
        Serialized binary protobuf message
    """
    if not PROTOBUF_AVAILABLE:
        raise ImportError("Protocol Buffer modules not available. Run: python scripts/compile_proto.py")
    
    # Create order book message
    depth = streaming_pb2.OrderBookDepth()
    depth.pool_id = pool_id
    depth.base_asset = base_asset
    depth.quote_asset = quote_asset
    depth.timestamp.CopyFrom(_datetime_to_timestamp(timestamp))
    depth.sequence = sequence
    depth.is_snapshot = is_snapshot
    
    # Add bid levels
    for bid in bids:
        level = depth.bids.add()
        level.price = _decimal_to_string(bid["price"])
        level.amount = _decimal_to_string(bid["amount"])
        level.order_count = bid.get("order_count", 0)
    
    # Add ask levels
    for ask in asks:
        level = depth.asks.add()
        level.price = _decimal_to_string(ask["price"])
        level.amount = _decimal_to_string(ask["amount"])
        level.order_count = ask.get("order_count", 0)
    
    # Wrap in StreamMessage envelope
    stream_msg = streaming_pb2.StreamMessage()
    stream_msg.type = streaming_pb2.StreamMessage.ORDER_BOOK_DEPTH
    stream_msg.channel = channel or f"depth:{pool_id}"
    stream_msg.order_book_depth.CopyFrom(depth)
    
    return stream_msg.SerializeToString()


def create_pricing_update_message(
    pool_id: str,
    base_asset: str,
    quote_asset: str,
    last_price: Any,
    bid_price: Any,
    ask_price: Any,
    high_24h: Any,
    low_24h: Any,
    volume_24h: Any,
    quote_volume_24h: Any,
    price_change_24h: Any,
    price_change_pct_24h: Any,
    timestamp: datetime,
    channel: str = None
) -> bytes:
    """Create a serialized PricingUpdate message.
    
    Args:
        pool_id: Trading pool identifier
        base_asset: Base asset code
        quote_asset: Quote asset code
        last_price: Last trade price
        bid_price: Best bid price
        ask_price: Best ask price
        high_24h: 24h high price
        low_24h: 24h low price
        volume_24h: 24h volume in base asset
        quote_volume_24h: 24h volume in quote asset
        price_change_24h: Absolute price change
        price_change_pct_24h: Percentage price change
        timestamp: Update timestamp
        channel: Optional channel name (defaults to "pricing:{pool_id}")
    
    Returns:
        Serialized binary protobuf message
    """
    if not PROTOBUF_AVAILABLE:
        raise ImportError("Protocol Buffer modules not available. Run: python scripts/compile_proto.py")
    
    # Create pricing update message
    pricing = streaming_pb2.PricingUpdate()
    pricing.pool_id = pool_id
    pricing.base_asset = base_asset
    pricing.quote_asset = quote_asset
    pricing.last_price = _decimal_to_string(last_price)
    pricing.bid_price = _decimal_to_string(bid_price)
    pricing.ask_price = _decimal_to_string(ask_price)
    pricing.high_24h = _decimal_to_string(high_24h)
    pricing.low_24h = _decimal_to_string(low_24h)
    pricing.volume_24h = _decimal_to_string(volume_24h)
    pricing.quote_volume_24h = _decimal_to_string(quote_volume_24h)
    pricing.price_change_24h = _decimal_to_string(price_change_24h)
    pricing.price_change_pct_24h = _decimal_to_string(price_change_pct_24h)
    pricing.timestamp.CopyFrom(_datetime_to_timestamp(timestamp))
    
    # Wrap in StreamMessage envelope
    stream_msg = streaming_pb2.StreamMessage()
    stream_msg.type = streaming_pb2.StreamMessage.PRICING_UPDATE
    stream_msg.channel = channel or f"pricing:{pool_id}"
    stream_msg.pricing_update.CopyFrom(pricing)
    
    return stream_msg.SerializeToString()


def create_pool_stats_message(
    pool_id: str,
    total_liquidity_usd: Any,
    volume_24h_usd: Any,
    fee_rate: Any,
    trade_count_24h: int,
    timestamp: datetime,
    channel: str = None
) -> bytes:
    """Create a serialized PoolStats message.
    
    Args:
        pool_id: Trading pool identifier
        total_liquidity_usd: Total liquidity in USD
        volume_24h_usd: 24h volume in USD
        fee_rate: Fee rate (e.g., "0.003" for 0.3%)
        trade_count_24h: Number of trades in 24h
        timestamp: Update timestamp
        channel: Optional channel name (defaults to "pool_stats:{pool_id}")
    
    Returns:
        Serialized binary protobuf message
    """
    if not PROTOBUF_AVAILABLE:
        raise ImportError("Protocol Buffer modules not available. Run: python scripts/compile_proto.py")
    
    # Create pool stats message
    stats = streaming_pb2.PoolStats()
    stats.pool_id = pool_id
    stats.total_liquidity_usd = _decimal_to_string(total_liquidity_usd)
    stats.volume_24h_usd = _decimal_to_string(volume_24h_usd)
    stats.fee_rate = _decimal_to_string(fee_rate)
    stats.trade_count_24h = trade_count_24h
    stats.timestamp.CopyFrom(_datetime_to_timestamp(timestamp))
    
    # Wrap in StreamMessage envelope
    stream_msg = streaming_pb2.StreamMessage()
    stream_msg.type = streaming_pb2.StreamMessage.POOL_STATS
    stream_msg.channel = channel or f"pool_stats:{pool_id}"
    stream_msg.pool_stats.CopyFrom(stats)
    
    return stream_msg.SerializeToString()


def create_heartbeat_message(timestamp: datetime) -> bytes:
    """Create a serialized Heartbeat message.
    
    Args:
        timestamp: Heartbeat timestamp
    
    Returns:
        Serialized binary protobuf message
    """
    if not PROTOBUF_AVAILABLE:
        raise ImportError("Protocol Buffer modules not available. Run: python scripts/compile_proto.py")
    
    # Create heartbeat message
    heartbeat = streaming_pb2.Heartbeat()
    heartbeat.timestamp.CopyFrom(_datetime_to_timestamp(timestamp))
    heartbeat.server_sequence = int(timestamp.timestamp() * 1000000)  # Microsecond precision
    
    # Wrap in StreamMessage envelope
    stream_msg = streaming_pb2.StreamMessage()
    stream_msg.type = streaming_pb2.StreamMessage.HEARTBEAT
    stream_msg.channel = "system"
    stream_msg.heartbeat.CopyFrom(heartbeat)
    
    return stream_msg.SerializeToString()


def create_error_message(code: str, message: str, timestamp: Optional[datetime] = None) -> bytes:
    """Create a serialized StreamError message.
    
    Args:
        code: Error code (e.g., "PARSE_ERROR", "INVALID_CHANNEL")
        message: Human-readable error message
        timestamp: Error timestamp (defaults to now)
    
    Returns:
        Serialized binary protobuf message
    """
    if not PROTOBUF_AVAILABLE:
        raise ImportError("Protocol Buffer modules not available. Run: python scripts/compile_proto.py")
    
    if timestamp is None:
        timestamp = datetime.utcnow()
    
    # Create error message
    error = streaming_pb2.StreamError()
    error.code = code
    error.message = message
    error.timestamp.CopyFrom(_datetime_to_timestamp(timestamp))
    
    # Wrap in StreamMessage envelope
    stream_msg = streaming_pb2.StreamMessage()
    stream_msg.type = streaming_pb2.StreamMessage.ERROR
    stream_msg.channel = "system"
    stream_msg.error.CopyFrom(error)
    
    return stream_msg.SerializeToString()


def create_subscription_confirm(channel: str, subscribed: bool, timestamp: Optional[datetime] = None) -> bytes:
    """Create a serialized SubscriptionConfirm message.
    
    Args:
        channel: Channel name
        subscribed: True if subscribed, False if unsubscribed
        timestamp: Confirmation timestamp (defaults to now)
    
    Returns:
        Serialized binary protobuf message
    """
    if not PROTOBUF_AVAILABLE:
        raise ImportError("Protocol Buffer modules not available. Run: python scripts/compile_proto.py")
    
    if timestamp is None:
        timestamp = datetime.utcnow()
    
    # Create subscription confirmation message
    confirm = streaming_pb2.SubscriptionConfirm()
    confirm.channel = channel
    confirm.subscribed = subscribed
    confirm.timestamp.CopyFrom(_datetime_to_timestamp(timestamp))
    
    # Wrap in StreamMessage envelope
    stream_msg = streaming_pb2.StreamMessage()
    stream_msg.type = streaming_pb2.StreamMessage.SUBSCRIPTION_CONFIRM
    stream_msg.channel = channel
    stream_msg.subscription_confirm.CopyFrom(confirm)
    
    return stream_msg.SerializeToString()


def parse_subscription_request(binary_data: bytes) -> Dict[str, Any]:
    """Parse a binary SubscriptionRequest message.
    
    Args:
        binary_data: Serialized protobuf bytes
    
    Returns:
        Dictionary with "action" and "channels" keys
    
    Raises:
        ValueError: If message cannot be parsed
    """
    if not PROTOBUF_AVAILABLE:
        raise ImportError("Protocol Buffer modules not available. Run: python scripts/compile_proto.py")
    
    try:
        request = streaming_pb2.SubscriptionRequest()
        request.ParseFromString(binary_data)
        
        action_map = {
            streaming_pb2.SubscriptionRequest.SUBSCRIBE: "subscribe",
            streaming_pb2.SubscriptionRequest.UNSUBSCRIBE: "unsubscribe",
            streaming_pb2.SubscriptionRequest.PING: "ping",
        }
        
        return {
            "action": action_map.get(request.action, "unknown"),
            "channels": list(request.channels)
        }
    except Exception as e:
        raise ValueError(f"Failed to parse subscription request: {e}")


# Utility functions for testing and comparison

def estimate_json_size(data: Dict[str, Any]) -> int:
    """Estimate JSON message size for comparison.
    
    Args:
        data: Dictionary representing the message
    
    Returns:
        Approximate size in bytes
    """
    import json
    return len(json.dumps(data).encode('utf-8'))


def compare_message_sizes(proto_message: bytes, json_data: Dict[str, Any]) -> Dict[str, Any]:
    """Compare protobuf vs JSON message sizes.
    
    Args:
        proto_message: Serialized protobuf message
        json_data: Equivalent JSON data
    
    Returns:
        Dictionary with size comparison statistics
    """
    proto_size = len(proto_message)
    json_size = estimate_json_size(json_data)
    reduction = ((json_size - proto_size) / json_size) * 100
    
    return {
        "protobuf_bytes": proto_size,
        "json_bytes": json_size,
        "reduction_bytes": json_size - proto_size,
        "reduction_percent": round(reduction, 2),
        "compression_ratio": round(json_size / proto_size, 2)
    }
