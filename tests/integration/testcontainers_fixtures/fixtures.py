"""Pytest fixtures providing Docker test containers for integration tests.

Session-scoped fixtures
-----------------------
* ``postgres_container`` — PostgreSQL 16 via testcontainers
* ``redis_container`` — Redis 7 via testcontainers
* ``horizon_mock_server`` — In-process FastAPI Horizon mock

Function-scoped fixtures
-------------------------
* ``db_url`` / ``async_db_url`` — SQLAlchemy connection URLs
* ``db_engine`` / ``async_db_engine`` — SQLAlchemy engines
* ``db_session`` / ``async_db_session`` — SQLAlchemy sessions (auto-rolled-back)
* ``redis_client`` / ``async_redis_client`` — Redis connections
* ``horizon_url`` — Base URL of the Horizon mock

All containers are started once per session and reused across tests.
Database sessions are rolled back after each test for isolation.
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
from pathlib import Path
from typing import AsyncGenerator, Generator

import pytest
import redis
import redis.asyncio as aioredis

# ---------------------------------------------------------------------------
# Ensure app modules are importable
# ---------------------------------------------------------------------------
_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
_SRC = _ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))


# ---------------------------------------------------------------------------
# Session-scoped containers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def postgres_container():
    """Start a PostgreSQL 16 Docker container for the test session.

    Yields the testcontainers ``PostgresContainer`` instance.  The container
    is automatically stopped when the test session ends.
    """
    try:
        from testcontainers.community.postgres import PostgresContainer
    except ImportError:
        try:
            from testcontainers.postgres import PostgresContainer
        except ImportError:
            pytest.skip("testcontainers[postgres] is not installed")

    container = PostgresContainer(
        image="postgres:16-alpine",
        username="testuser",
        password="testpass",
        dbname="stellarflow_test",
    )
    container.start()

    yield container

    container.stop()


@pytest.fixture(scope="session")
def redis_container():
    """Start a Redis 7 Docker container for the test session.

    Yields the testcontainers ``RedisContainer`` instance.  The container
    is automatically stopped when the test session ends.
    """
    try:
        from testcontainers.community.redis import RedisContainer
    except ImportError:
        try:
            from testcontainers.redis import RedisContainer
        except ImportError:
            pytest.skip("testcontainers[redis] is not installed")

    container = RedisContainer(image="redis:7-alpine")
    container.start()

    yield container

    container.stop()


@pytest.fixture(scope="session")
def horizon_mock_server():
    """Start the in-process Horizon mock server for the test session.

    Yields a :class:`HorizonMockServer` instance with mutable state
    for injecting faults.
    """
    from tests.integration.testcontainers_fixtures.horizon_mock import (
        start_horizon_mock,
        stop_horizon_mock,
    )

    server = start_horizon_mock(timeout=15.0)
    yield server
    stop_horizon_mock()


# ---------------------------------------------------------------------------
# Connection URL fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def db_url(postgres_container) -> str:
    """Return the synchronous SQLAlchemy connection URL for the test PostgreSQL."""
    return postgres_container.get_connection_url().replace("+psycopg2", "")


@pytest.fixture(scope="session")
def async_db_url(postgres_container) -> str:
    """Return the async SQLAlchemy connection URL (asyncpg) for the test PostgreSQL."""
    sync_url = postgres_container.get_connection_url()
    # testcontainers returns postgresql+psycopg2://...; convert to asyncpg
    async_url = sync_url.replace("+psycopg2", "")
    if async_url.startswith("postgresql://"):
        async_url = async_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return async_url


@pytest.fixture(scope="session")
def horizon_url(horizon_mock_server) -> str:
    """Return the base URL of the Horizon mock server."""
    return horizon_mock_server.base_url


# ---------------------------------------------------------------------------
# Redis URL helper
# ---------------------------------------------------------------------------


def _get_redis_url(container) -> str:
    """Construct a Redis connection URL from a testcontainers RedisContainer."""
    host = container.get_container_host_ip()
    port = container.get_exposed_port(6379)
    return f"redis://{host}:{port}"


# ---------------------------------------------------------------------------
# SQLAlchemy engine fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def db_engine(db_url):
    """Create a synchronous SQLAlchemy engine connected to the test PostgreSQL."""
    from sqlalchemy import create_engine

    engine = create_engine(
        db_url,
        pool_size=5,
        max_overflow=10,
        pool_pre_ping=True,
        echo=False,
    )
    yield engine
    engine.dispose()


@pytest.fixture(scope="session")
def async_db_engine(async_db_url):
    """Create an async SQLAlchemy engine connected to the test PostgreSQL.

    The engine is shared across tests but connections are created per-test.
    """
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(
        async_db_url,
        pool_size=5,
        max_overflow=10,
        pool_pre_ping=True,
        echo=False,
    )
    yield engine


# ---------------------------------------------------------------------------
# Database schema fixture
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def _create_schema(db_engine):
    """Create the ``ledger_events`` table (and partitions) in the test database.

    Runs once per session after the engine is created.
    """
    from sqlalchemy import text
    from app.models.events import LedgerEvent

    from sqlalchemy.orm import DeclarativeBase

    class _Base(DeclarativeBase):
        pass

    # Import the LedgerEvent and create its table via metadata
    LedgerEvent.__table__.metadata.create_all(db_engine)

    yield

    LedgerEvent.__table__.metadata.drop_all(db_engine)


# ---------------------------------------------------------------------------
# SQLAlchemy session fixtures (function-scoped, auto-rollback)
# ---------------------------------------------------------------------------


@pytest.fixture
def db_session(db_engine, _create_schema):
    """Yield a synchronous SQLAlchemy session that is rolled back after each test.

    This provides full isolation between tests — no cleanup needed.
    """
    from sqlalchemy.orm import Session

    connection = db_engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection)

    yield session

    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture
async def async_db_session(async_db_url, _create_schema):
    """Yield an async SQLAlchemy session that is rolled back after each test.

    Creates a fresh engine per test to avoid event loop issues.
    """
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

    engine = create_async_engine(
        async_db_url,
        pool_size=2,
        max_overflow=5,
        pool_pre_ping=True,
        echo=False,
    )

    async with engine.connect() as conn:
        trans = await conn.begin()
        session = AsyncSession(bind=conn, expire_on_commit=False)

        yield session

        await session.close()
        await trans.rollback()

    await engine.dispose()


# ---------------------------------------------------------------------------
# Redis client fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def redis_client(redis_container) -> redis.Redis:
    """Return a synchronous Redis client connected to the test Redis container."""
    connection_url = _get_redis_url(redis_container)
    client = redis.from_url(
        connection_url,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=5,
    )
    yield client
    client.close()


@pytest.fixture
def redis_client_fresh(redis_client) -> redis.Redis:
    """Return a Redis client with the test database flushed before each test."""
    redis_client.flushdb()
    yield redis_client
    redis_client.flushdb()


@pytest.fixture
async def async_redis_client(redis_container):
    """Return an async Redis client connected to the test Redis container."""
    connection_url = _get_redis_url(redis_container)
    client = await aioredis.from_url(
        connection_url,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=5,
    )
    yield client
    await client.aclose()


# ---------------------------------------------------------------------------
# Environment variable helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _set_test_env(db_url, redis_container, horizon_url):
    """Set environment variables required by app modules for the test session."""
    os.environ["DATABASE_URL"] = db_url
    os.environ["REDIS_URL"] = _get_redis_url(redis_container)
    os.environ["HORIZON_URL"] = horizon_url
    os.environ["SIGNER_BACKEND"] = "local"
    os.environ["STELLAR_SECRET"] = "SDON4BI7DPYRITW7QBJMJ6KOESXAVIYPUXBDDTIEDDN4TTN6YHQTF7QA"
    os.environ["ANCHOR_WEBHOOK_SECRET"] = "test-webhook-secret"
    yield
