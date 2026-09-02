"""app/db/session.py — SQLAlchemy async session factory for StellarFlow.

Provides ``async_session_factory`` used by the ingestion layer
(``soroban_listener.py``) to persist ``LedgerEvent`` records.

Usage::

    from app.db.session import async_session_factory
    from app.models.events import LedgerEvent

    async with async_session_factory() as session:
        session.add(LedgerEvent(...))
        await session.commit()
"""

from __future__ import annotations

import os
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

_DATABASE_URL = os.environ.get("DATABASE_URL", "")

if not _DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL environment variable is not set. "
        "Required by app.db.session for the async session factory."
    )

# Normalise a plain postgresql:// URL to the asyncpg+psycopg driver prefix
# that SQLAlchemy expects for async operations.
async_url = _DATABASE_URL
if async_url.startswith("postgresql://"):
    async_url = async_url.replace("postgresql://", "postgresql+asyncpg://", 1)
elif async_url.startswith("postgres://"):
    async_url = async_url.replace("postgres://", "postgresql+asyncpg://", 1)

_engine_kwargs = {
    "pool_pre_ping": True,
    "echo": False,
}

# PgBouncer owns server-side pooling; keep the application-side pool bounded.
if os.environ.get("PGBOUNCER_ENABLED", "false").lower() == "true":
    _engine_kwargs.update({
        "pool_size": 5,
        "max_overflow": 5,
        "connect_args": {"statement_cache_size": 0},
    })
else:
    _engine_kwargs.update({"pool_size": 10, "max_overflow": 20})

_engine = create_async_engine(async_url, **_engine_kwargs)

async_session_factory = async_sessionmaker(
    bind=_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields an ``AsyncSession`` and closes it after use."""
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
