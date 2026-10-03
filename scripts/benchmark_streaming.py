#!/usr/bin/env python3
"""
Benchmark Protocol Buffer vs JSON message sizes for streaming data.

This script compares the bandwidth usage between binary Protocol Buffer
encoding and JSON encoding for various market data message types.

Usage:
    python scripts/benchmark_streaming.py

Requirements:
    - protobuf>=4.25.0
    - Run: python scripts/compile_proto.py first to generate proto bindings
"""

import json
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Dict, List, Any

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

try:
    from app.services.proto_serializer import (
        create_market_trade_message,
        create_order_book_depth_message,
        create_pricing_update_message,
        create_pool_stats_message,
        compare_message_sizes,
    )
    PROTOBUF_AVAILABLE = True
except ImportError as e:
    print(f"❌ Error: Could not import proto serializer: {e}")
    print("\nPlease ensure:")
    print("1. Dependencies are installed: pip install -r requirements.txt")
    print("2. Proto files are compiled: python scripts/compile_proto.py")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Sample Data Generation
# ---------------------------------------------------------------------------

def generate_market_trade_data() -> Dict[str, Any]:
    """Generate sample market trade data."""
    return {
        "trade_id": "TRD-20260929-XLM-USDC-1234567890",
        "pool_id": "XLM-USDC",
        "base_asset": "XLM",
        "quote_asset": "USDC",
        "price": "0.12456789",
        "amount": "15000.50",
        "side": "buy",
        "timestamp": "2026-09-29T14:30:45.123456Z",
        "sequence": 9876543210
    }


def generate_order_book_depth_data() -> Dict[str, Any]:
    """Generate sample order book depth data."""
    return {
        "pool_id": "XLM-USDC",
        "base_asset": "XLM",
        "quote_asset": "USDC",
        "bids": [
            {"price": "0.12456789", "amount": "10000.00", "order_count": 5},
            {"price": "0.12456788", "amount": "8500.50", "order_count": 3},
            {"price": "0.12456787", "amount": "12000.25", "order_count": 7},
            {"price": "0.12456786", "amount": "5000.00", "order_count": 2},
            {"price": "0.12456785", "amount": "15000.75", "order_count": 4},
        ],
        "asks": [
            {"price": "0.12456790", "amount": "9000.00", "order_count": 4},
            {"price": "0.12456791", "amount": "11000.50", "order_count": 6},
            {"price": "0.12456792", "amount": "7500.25", "order_count": 3},
            {"price": "0.12456793", "amount": "13000.00", "order_count": 8},
            {"price": "0.12456794", "amount": "6000.75", "order_count": 2},
        ],
        "timestamp": "2026-09-29T14:30:45.123456Z",
        "sequence": 9876543210,
        "is_snapshot": True
    }


def generate_pricing_update_data() -> Dict[str, Any]:
    """Generate sample pricing update data."""
    return {
        "pool_id": "XLM-USDC",
        "base_asset": "XLM",
        "quote_asset": "USDC",
        "last_price": "0.12456789",
        "bid_price": "0.12456788",
        "ask_price": "0.12456790",
        "high_24h": "0.12789000",
        "low_24h": "0.12100000",
        "volume_24h": "1234567.89",
        "quote_volume_24h": "153456.78",
        "price_change_24h": "0.00356789",
        "price_change_pct_24h": "2.95",
        "timestamp": "2026-09-29T14:30:45.123456Z"
    }


def generate_pool_stats_data() -> Dict[str, Any]:
    """Generate sample pool statistics data."""
    return {
        "pool_id": "XLM-USDC",
        "total_liquidity_usd": "5678901.23",
        "volume_24h_usd": "234567.89",
        "fee_rate": "0.003",
        "trade_count_24h": 1542,
        "timestamp": "2026-09-29T14:30:45.123456Z"
    }


# ---------------------------------------------------------------------------
# Benchmarking Functions
# ---------------------------------------------------------------------------

def benchmark_market_trade():
    """Benchmark market trade message."""
    print("\n📊 Market Trade Message")
    print("=" * 60)
    
    data = generate_market_trade_data()
    
    # Create protobuf message
    proto_msg = create_market_trade_message(
        trade_id=data["trade_id"],
        pool_id=data["pool_id"],
        base_asset=data["base_asset"],
        quote_asset=data["quote_asset"],
        price=data["price"],
        amount=data["amount"],
        side=data["side"],
        timestamp=datetime.utcnow(),
        sequence=data["sequence"]
    )
    
    # Create equivalent JSON
    json_data = {
        "channel": f"trade:{data['pool_id']}",
        "data": data
    }
    
    # Compare sizes
    comparison = compare_message_sizes(proto_msg, json_data)
    
    print(f"Protocol Buffer: {comparison['protobuf_bytes']} bytes")
    print(f"JSON:           {comparison['json_bytes']} bytes")
    print(f"Reduction:      {comparison['reduction_bytes']} bytes ({comparison['reduction_percent']}%)")
    print(f"Compression:    {comparison['compression_ratio']}x")
    
    return comparison


def benchmark_order_book_depth():
    """Benchmark order book depth message."""
    print("\n📊 Order Book Depth Message (10 levels)")
    print("=" * 60)
    
    data = generate_order_book_depth_data()
    
    # Create protobuf message
    proto_msg = create_order_book_depth_message(
        pool_id=data["pool_id"],
        base_asset=data["base_asset"],
        quote_asset=data["quote_asset"],
        bids=data["bids"],
        asks=data["asks"],
        timestamp=datetime.utcnow(),
        sequence=data["sequence"],
        is_snapshot=data["is_snapshot"]
    )
    
    # Create equivalent JSON
    json_data = {
        "channel": f"depth:{data['pool_id']}",
        "data": data
    }
    
    # Compare sizes
    comparison = compare_message_sizes(proto_msg, json_data)
    
    print(f"Protocol Buffer: {comparison['protobuf_bytes']} bytes")
    print(f"JSON:           {comparison['json_bytes']} bytes")
    print(f"Reduction:      {comparison['reduction_bytes']} bytes ({comparison['reduction_percent']}%)")
    print(f"Compression:    {comparison['compression_ratio']}x")
    
    return comparison


def benchmark_pricing_update():
    """Benchmark pricing update message."""
    print("\n📊 Pricing Update Message")
    print("=" * 60)
    
    data = generate_pricing_update_data()
    
    # Create protobuf message
    proto_msg = create_pricing_update_message(
        pool_id=data["pool_id"],
        base_asset=data["base_asset"],
        quote_asset=data["quote_asset"],
        last_price=data["last_price"],
        bid_price=data["bid_price"],
        ask_price=data["ask_price"],
        high_24h=data["high_24h"],
        low_24h=data["low_24h"],
        volume_24h=data["volume_24h"],
        quote_volume_24h=data["quote_volume_24h"],
        price_change_24h=data["price_change_24h"],
        price_change_pct_24h=data["price_change_pct_24h"],
        timestamp=datetime.utcnow()
    )
    
    # Create equivalent JSON
    json_data = {
        "channel": f"pricing:{data['pool_id']}",
        "data": data
    }
    
    # Compare sizes
    comparison = compare_message_sizes(proto_msg, json_data)
    
    print(f"Protocol Buffer: {comparison['protobuf_bytes']} bytes")
    print(f"JSON:           {comparison['json_bytes']} bytes")
    print(f"Reduction:      {comparison['reduction_bytes']} bytes ({comparison['reduction_percent']}%)")
    print(f"Compression:    {comparison['compression_ratio']}x")
    
    return comparison


def benchmark_pool_stats():
    """Benchmark pool statistics message."""
    print("\n📊 Pool Statistics Message")
    print("=" * 60)
    
    data = generate_pool_stats_data()
    
    # Create protobuf message
    proto_msg = create_pool_stats_message(
        pool_id=data["pool_id"],
        total_liquidity_usd=data["total_liquidity_usd"],
        volume_24h_usd=data["volume_24h_usd"],
        fee_rate=data["fee_rate"],
        trade_count_24h=data["trade_count_24h"],
        timestamp=datetime.utcnow()
    )
    
    # Create equivalent JSON
    json_data = {
        "channel": f"pool_stats:{data['pool_id']}",
        "data": data
    }
    
    # Compare sizes
    comparison = compare_message_sizes(proto_msg, json_data)
    
    print(f"Protocol Buffer: {comparison['protobuf_bytes']} bytes")
    print(f"JSON:           {comparison['json_bytes']} bytes")
    print(f"Reduction:      {comparison['reduction_bytes']} bytes ({comparison['reduction_percent']}%)")
    print(f"Compression:    {comparison['compression_ratio']}x")
    
    return comparison


def calculate_bandwidth_savings(comparisons: List[Dict[str, Any]]):
    """Calculate overall bandwidth savings."""
    print("\n" + "=" * 60)
    print("📈 OVERALL BANDWIDTH ANALYSIS")
    print("=" * 60)
    
    total_proto = sum(c['protobuf_bytes'] for c in comparisons)
    total_json = sum(c['json_bytes'] for c in comparisons)
    avg_reduction = sum(c['reduction_percent'] for c in comparisons) / len(comparisons)
    
    print(f"\nTotal Protocol Buffer: {total_proto} bytes")
    print(f"Total JSON:           {total_json} bytes")
    print(f"Total Reduction:      {total_json - total_proto} bytes")
    print(f"Average Reduction:    {avg_reduction:.2f}%")
    
    # Simulate bandwidth over 1 hour with various message rates
    print("\n" + "-" * 60)
    print("Bandwidth Usage Simulation (1 hour)")
    print("-" * 60)
    
    message_rates = [10, 100, 1000]  # messages per second
    
    for rate in message_rates:
        messages_per_hour = rate * 3600
        proto_bandwidth = (total_proto / len(comparisons)) * messages_per_hour
        json_bandwidth = (total_json / len(comparisons)) * messages_per_hour
        savings = json_bandwidth - proto_bandwidth
        
        print(f"\n{rate} messages/second:")
        print(f"  Protobuf: {proto_bandwidth / 1024 / 1024:.2f} MB/hour")
        print(f"  JSON:     {json_bandwidth / 1024 / 1024:.2f} MB/hour")
        print(f"  Saved:    {savings / 1024 / 1024:.2f} MB/hour ({avg_reduction:.1f}%)")
    
    return avg_reduction


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    """Run all benchmarks."""
    print("\n" + "=" * 60)
    print("🚀 Protocol Buffer vs JSON Streaming Benchmark")
    print("=" * 60)
    
    comparisons = []
    
    # Run individual benchmarks
    comparisons.append(benchmark_market_trade())
    comparisons.append(benchmark_order_book_depth())
    comparisons.append(benchmark_pricing_update())
    comparisons.append(benchmark_pool_stats())
    
    # Calculate overall savings
    avg_reduction = calculate_bandwidth_savings(comparisons)
    
    # Final verdict
    print("\n" + "=" * 60)
    print("✅ ACCEPTANCE CRITERIA VALIDATION")
    print("=" * 60)
    
    if avg_reduction >= 50:
        print(f"\n✅ PASS: Average bandwidth reduction is {avg_reduction:.2f}%")
        print(f"   Target: >50% reduction")
        print(f"   Achieved: {avg_reduction:.2f}% reduction")
        print("\n🎉 Protocol Buffers successfully reduce bandwidth by more than 50%!")
    else:
        print(f"\n❌ FAIL: Average bandwidth reduction is {avg_reduction:.2f}%")
        print(f"   Target: >50% reduction")
        print(f"   Achieved: {avg_reduction:.2f}% reduction")
    
    print("\n" + "=" * 60)
    print("Benchmark Complete")
    print("=" * 60 + "\n")
    
    return 0 if avg_reduction >= 50 else 1


if __name__ == "__main__":
    sys.exit(main())
