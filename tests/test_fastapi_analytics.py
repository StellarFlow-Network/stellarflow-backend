from __future__ import annotations

import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi.testclient import TestClient
from src.api.main import app
from src.cache.redis_cache import redis_cache


@pytest.fixture(autouse=True)
async def clear_cache_before_test():
    await redis_cache.clear()
    yield
    await redis_cache.clear()


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def test_get_pool_stats_success(client):
    """Test GET /api/v1/pools/{pool_id}/stats returns valid pool data."""
    response = client.get("/api/v1/pools/xlm-usdc/stats")
    assert response.status_code == 200
    data = response.json()
    assert data["pool_id"] == "xlm-usdc"
    assert data["asset_pair"] == "XLM/USDC"
    assert "total_liquidity_usd" in data
    assert "volume_24h_usd" in data
    assert "current_price" in data
    assert "updated_at" in data


def test_get_pool_stats_caching(client):
    """Test 15-second response caching behavior for pool stats endpoint."""
    res1 = client.get("/api/v1/pools/xlm-ngn/stats")
    assert res1.status_code == 200
    assert res1.headers.get("X-Cache") == "MISS"
    assert res1.headers.get("X-Cache-TTL") == "15"

    res2 = client.get("/api/v1/pools/xlm-ngn/stats")
    assert res2.status_code == 200
    assert res2.headers.get("X-Cache") == "HIT"
    assert res2.json() == res1.json()


def test_get_pool_stats_not_found(client):
    """Test GET /api/v1/pools/{pool_id}/stats with invalid pool ID returns 404."""
    response = client.get("/api/v1/pools/unknownpoolname/stats")
    assert response.status_code == 404
    data = response.json()
    assert "detail" in data or "error" in data


def test_get_volume_analytics_success(client):
    """Test GET /api/v1/analytics/volume returns volume data."""
    response = client.get("/api/v1/analytics/volume")
    assert response.status_code == 200
    data = response.json()
    assert data["timeframe"] == "24h"
    assert "total_volume_usd" in data
    assert len(data["volume_by_symbol"]) > 0
    assert len(data["historical_points"]) > 0


def test_get_volume_analytics_filtered(client):
    """Test GET /api/v1/analytics/volume with query parameters."""
    response = client.get("/api/v1/analytics/volume?symbol=XLM/NGN&limit=5&timeframe=7d")
    assert response.status_code == 200
    data = response.json()
    assert data["timeframe"] == "7d"
    assert len(data["historical_points"]) <= 5
    symbols = [s["symbol"] for s in data["volume_by_symbol"]]
    assert "XLM/NGN" in symbols


def test_get_health_status(client):
    """Test GET /api/v1/health returns system status."""
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    data = response.json()
    assert "status" in data
    assert "uptime_seconds" in data
    assert "redis_connected" in data
    assert "services" in data
    assert len(data["services"]) > 0


def test_openapi_schema_endpoint(client):
    """Test GET /openapi.json exposes full OpenAPI specifications for all endpoints."""
    response = client.get("/openapi.json")
    assert response.status_code == 200
    schema = response.json()
    assert schema["info"]["title"] == "StellarFlow Market Analytics API"
    assert "paths" in schema
    paths = schema["paths"]
    assert "/api/v1/pools/{pool_id}/stats" in paths
    assert "/api/v1/analytics/volume" in paths
    assert "/api/v1/health" in paths
    
    # Check OpenAPI schema components
    assert "components" in schema
    schemas = schema["components"]["schemas"]
    assert "PoolStatsResponse" in schemas
    assert "VolumeAnalyticsResponse" in schemas
    assert "HealthResponse" in schemas
