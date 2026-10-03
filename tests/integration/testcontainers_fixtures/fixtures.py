"""Pytest fixtures providing Docker test containers for integration tests.

Two execution modes are supported:

**1. Self-provisioned (default).**  When ``TEST_DATABASE_URL`` and
``TEST_REDIS_URL`` are unset, PostgreSQL 16 and Redis 7 are started with
``testcontainers`` and torn down at the end of the session.  This is the
path used by bare-metal developers running ``pytest`` directly.

**2. Compose-provisioned.**  When both variables are set, the fixtures attach
to services that are already running (e.g. the ``db`` / ``redis`` containers
from ``docker-compose.test.yml``) instead of starting nested containers.
This keeps the test runner free of a Docker-socket mount, which is what makes
``make test`` work identically on a developer laptop and on a CI runner.

Session-scoped fixtures
-----------------------
* ``postgres_container`` — PostgreSQL 16 (testcontainer or external service)
* ``redis_container`` — Redis 7 (testcontainer or external service)
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
from typing import AsyncGenerator, Generator, Optional
from urllib.parse import urlparse

import psycopg2
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
# External (compose-provisioned) service support
# ---------------------------------------------------------------------------
#
# ``docker-compose.test.yml`` starts PostgreSQL and Redis alongside the test
# runner and passes their URLs in.  When those are present we deliberately do
# NOT start nested testcontainers — a container cannot reach the Docker
# daemon unless the socket is mounted, and mounting it would let the test
# suite mutate the host's images.  Compose owns the lifecycle instead.

_EXTERNAL_DB_URL = os.environ.get("TEST_DATABASE_URL", "").strip()
_EXTERNAL_REDIS_URL = os.environ.get("TEST_REDIS_URL", "").strip()


def _using_external_services() -> bool:
    """Return True when both Postgres and Redis are supplied by the environment."""
    return bool(_EXTERNAL_DB_URL and _EXTERNAL_REDIS_URL)


class _ExternalPostgres:
    """Adapter that mimics the slice of the testcontainers API the fixtures use.

    Lets the rest of this module stay agnostic about whether the database came
    from testcontainers or from ``docker-compose.test.yml``.
    """

    def __init__(self, url: str) -> None:
        self._url = url

    def get_connection_url(self) -> str:
        return self._url

    def stop(self) -> None:  # pragma: no cover - nothing to tear down
        """No-op: compose owns the container lifecycle."""


class _ExternalRedis:
    """Adapter mirroring ``RedisContainer`` for a compose-provisioned Redis."""

    def __init__(self, url: str) -> None:
        self._url = url
        parsed = urlparse(url)
        self._host = parsed.hostname or "localhost"
        self._port = parsed.port or 6379

    def get_container_host_ip(self) -> str:
        return self._host

    def get_exposed_port(self, port: int) -> int:
        return self._port

    def stop(self) -> None:  # pragma: no cover - nothing to tear down
        """No-op: compose owns the container lifecycle."""


def _wait_for_postgres(url: str, timeout: float = 60.0) -> None:
    """Block until the external PostgreSQL accepts connections.

    Compose gates the runner on a healthcheck, but CI runners and laptop
    restarts can race, so we poll defensively before failing a test.
    """
    deadline = time.monotonic() + timeout
    last_error: Optional[BaseException] = None
    while time.monotonic() < deadline:
        try:
            conn = psycopg2.connect(_strip_async_driver(url), connect_timeout=3)
            conn.close()
            return
        except Exception as exc:  # pragma: no cover - timing dependent
            last_error = exc
            time.sleep(0.5)
    raise RuntimeError(
        f"PostgreSQL at {url!r} not ready after {timeout}s: {last_error}"
    )


def _wait_for_redis(url: str, timeout: float = 60.0) -> None:
    """Block until the external Redis responds to PING."""
    deadline = time.monotonic() + timeout
    last_error: Optional[BaseException] = None
    while time.monotonic() < deadline:
        try:
            client = redis.from_url(url, socket_connect_timeout=3)
            try:
                if client.ping():
                    return
            finally:
                client.close()
        except Exception as exc:  # pragma: no cover - timing dependent
            last_error = exc
            time.sleep(0.5)
    raise RuntimeError(f"Redis at {url!r} not ready after {timeout}s: {last_error}")


def _strip_async_driver(url: str) -> str:
    """Return a libpq/psycopg2-compatible URL from any SQLAlchemy URL form."""
    return url.replace("postgresql+asyncpg://", "postgresql://").replace(
        "postgresql+psycopg2://", "postgresql://"
    )


# ---------------------------------------------------------------------------
# Session-scoped containers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def postgres_container():
    """Provide a PostgreSQL 16 server for the test session.

    Uses ``TEST_DATABASE_URL`` when set (docker-compose.test.yml), otherwise
    starts a ``testcontainers`` PostgreSQL 16 instance that is stopped when the
    test session ends.
    """
    if _using_external_services():
        _wait_for_postgres(_EXTERNAL_DB_URL)
        yield _ExternalPostgres(_strip_async_driver(_EXTERNAL_DB_URL))
        return

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
    """Provide a Redis 7 server for the test session.

    Uses ``TEST_REDIS_URL`` when set (docker-compose.test.yml), otherwise
    starts a ``testcontainers`` Redis 7 instance that is stopped when the
    test session ends.
    """
    if _using_external_services():
        _wait_for_redis(_EXTERNAL_REDIS_URL)
        yield _ExternalRedis(_EXTERNAL_REDIS_URL)
        return

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
