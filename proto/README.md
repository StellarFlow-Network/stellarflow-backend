# Protocol Buffers Definitions

This directory contains `.proto` files that define the binary message formats for WebSocket streaming endpoints.

## Files

- **streaming.proto** - Defines message schemas for market data streaming (trades, order books, pricing updates)
- **stellarflow_channels.proto** - Existing channel message definitions

## Compiling Proto Files

After modifying any `.proto` files, regenerate the Python bindings:

```bash
# Install dependencies first (if not already installed)
pip install -r requirements.txt

# Compile proto files to Python
python scripts/compile_proto.py
```

This generates Python modules in `app/proto_generated/` that can be imported by the application.

## Generated Files

The compilation script generates:
- `app/proto_generated/streaming_pb2.py` - Python classes for streaming.proto
- `app/proto_generated/stellarflow_channels_pb2.py` - Python classes for stellarflow_channels.proto
- `app/proto_generated/__init__.py` - Package initialization

**Do not edit generated files manually** - they will be overwritten on next compilation.

## Usage in Code

```python
from app.proto_generated import streaming_pb2

# Create a market trade message
trade = streaming_pb2.MarketTrade(
    trade_id="12345",
    pool_id="XLM-USDC",
    price="0.125",
    amount="10000",
    side="buy"
)

# Serialize to binary
binary_data = trade.SerializeToString()

# Deserialize from binary
parsed_trade = streaming_pb2.MarketTrade()
parsed_trade.ParseFromString(binary_data)
```

## Benefits

Protocol Buffers provide:
- **50-70% smaller message size** compared to JSON
- **Faster parsing** - binary format with no text parsing overhead
- **Type safety** - schema-defined messages with validation
- **Backward compatibility** - field numbers allow schema evolution
