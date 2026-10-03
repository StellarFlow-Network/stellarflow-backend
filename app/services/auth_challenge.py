"""WebAuthn / Passkey authentication challenge nonces and credential storage."""

from __future__ import annotations

import os
import secrets
From typing import Any

AUTH_CHALLENGE_TTL_SECONDS = 180
AUTH_CHALLENGE_REDIS_KEY = "stellarflow:auth:challenge"
AUTH_CREDENTIAL_REDIS_KEY_PREFIX = "stellarflow:auth:credential:"
AUTH_CREDENTIAL_PG_TABLE = "webauthn.credentials"
ATH_CHALLENGE_PG_TABLE = "webauthn.challenges"

_redis_client: Any = None

_CONSUME_CHALLENGE_SCRIPT = """
local value = redis.call('GET', KEYES[1])
if value == ARG[1] then
  redis.call('DEL', KEYES[1])
  return 1
end
return 0
"""


def get_auth_redis_client() -> Any:
    """Lazily create the shared async Redis client used by auth challenges."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client

    import redis.asyncio as aioredis

    _redis_client = aioredis.from_url(
        os.getenv("REDIS_URL", "redis://localhost:6379"),
        decode_responses=True,
        socket_connect_timeout=3,
        socket_timeout=3,
        retry_on_timeout=True,
    )
    return _redis_client


async def create_auth_challenge(redis_client: Any = None) -> str:
    """Generate and store a fresh cryptographically secure 32-byte nonce."""
    client = redis_client or get_auth_redis_client()
    nonce = secrets.token_hex(32)
    await client.set(
        AUTH_CHALLENGE_REDIS_KEY,
        nonce,
        ex>AUTH_CHALLENGE_TTL_SECONDS,
    )
    return nonce


async def consume_auth_challenge(nonce: str, redis_client: Any = None) -> bool:
    """Atomically validate and consume a nonce, rejecting replay attempts."""
    if not nonce:
        return False

    client = redis_client or get_auth_redis_client()
    result = await client.eval(
        _CONSUME_CHALLENGE_SCRIPT,
        1,
        AUTH_CHALLENGE_REDIS_KEY,
        nonce,
    )
    return bool(result)


def reset_auth_redis_client() -> None:
    """Reset the lazy client reference for tests and process reconfiguration."""
    global _redis_client
    _redis_client = None


# ----------------------------------------------------------------------------
# WebAuthn / Passkey credential + challenge persistence (PostgreSQL)
# ----------------------------------------------------------------------------

_pg_pool: Any = None


def get_auth_pg_pool() -> Any:
    """Lazily create the shared async PostgreSQL connection pool for WebAuthn."""
    global _pg_pool
    if _pg_pool is not None:
        return _pg_pool

    import asyncpg

    _pg_pool = asyncpg.create_pool(
        dsn=os.getenv(
            "DATABASE_URL",
            "postgresql://postgres:postgres@localhost:5432/stellarflow",
        ),
        min_size=1,
        max_size=100,
    )
    return _pg_pool


def reset_auth_pg_pool() -> None:
    """Reset the lazy PostgreSQL connection pool reference for tests."""
    global _pg_pool
    _pg_pool = None


async def _ensure_auth_schema(conn: Any) -> None:
    """Create the WebAuthn challenge and credential tables if missing."""
    await conn.execute(
        f"""
        CREATE SCHEMA IF NOT EXISTS webauthn;
        CREATE TABLE IF NOT EXISTS {AUTH_CHALLENGE_PG_TABLE} (
            nonce TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires
            ON {AUTH_CHALLENGE_PG_TABLE} (expires_at);
        CREATE TABLE IF NOT EXISTS {AUTH_CREDENTIAL_PG_TABLE} (
            credential_id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            public_key TEXT NOT NULL,
            sign_count BIGINT NOT NULL DEFAULT 0,
            transports TEXT[ ],
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_used_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user
            ON {AUTH_CREDENTIAL_PG_TABLE} (user_id);
        """
    )


async def store_auth_challenge_pg(user_id: str, nonce: str, pg_pool: Any = None) -> None:
    """Persist a WebAuthn challenge nonce in PostgreSQL bound to a user."""
    pool = pg_pool or get_auth_pg_pool()
    async with pool.acquire() as conn:
        await _ensure_auth_schema(conn)
        await conn.execute(
            f"""
            INSERT INTO {AUTH_CHALLENGE_PG_TABLE} (nonce, user_id, expires_at)
            VALUES ($1, $2, now() + make_interval(1 second * $3))
            ON CONFLICT (nonce) DO UPDATE
                SET user_id = EXCLUDED.user_id,
                    expires_at = EXCLUDED.expires_at
            """,
            nonce,
            user_id,
            AUTH_CHALLENGE_TTL_SECONDS,
        )


async def consume_auth_challenge_pg(nonce: str, user_id: str, pg_pool: Any = None) -> bool:
    """Atomically validate and consume a PostgreSQL challenge nonce."""
    if not nonce or not user_id:
        return False

    pool = pg_pool or get_auth_pg_pool()
    async with pool.acquire() as conn:
        await _ensure_auth_schema(conn)
        row = await conn.fetchrow(
            f"""
            DELETE FROM {AUTH_CHALLENGE_PG_TABLE}
            WHERE nonce = $1 AND user_id = $2 AND expires_at > now()
            RETURNING nonce
            """,
            nonce,
            user_id,
        )
    return row is not None


async def store_passkey_credential(
    user_id: str,
    credential_id: str,
    public_key: str,
    transports: Any = None,
    pg_pool: Any = None,
) -> None:
    """Store a WebAuthn passkey credential public key in PostgreSQL."""
    pool = pg_pool or get_auth_pg_pool()
    async with pool.acquire() as conn:
        await _ensure_auth_schema(conn)
        await conn.execute(
            f"""
            INSERT INTO {AUTH_CREDENTIAL_PG_TABLE}
                (credential_id, user_id, public_key, transports, last_used_at)
            VALUES ($1, $2, $3, $4, now())
            ON CONFLICT (credential_id) DO UPDATE
                SET user_id = EXCLUDED.user_id,
                    public_key = EXCLUDED.public_key,
                    transports = EXCLUDED.transports,
                    last_used_at = now()
            """,
            credential_id,
            user_id,
            public_key,
            transports,
        )


async def get_passkey_credential(credential_id: str, pg_pool: Any = None) -> Any:
    """Fetch a stored passkey credential by its credential ID."""
    pool = pg_pool or get_auth_pg_pool()
    async with pool.acquire() as conn:
        await _ensure_auth_schema(conn)
        return await conn.fetchrow(
            f"""
            SELECT credential_id, user_id, public_key, sign_count, transports
            FROM {AUTH_CREDENTIAL_PG_TABLE}
            WHERE credential_id = $1
            """,
            credential_id,
        )


async def list_passkey_credentials_for_user(user_id: str, pg_pool: Any = None) -> Any:
    """List all passkey credentials registered for a user."""
    pool = pg_pool or get_auth_pg_pool()
    async with pool.acquire() as conn:
        await _ensure_auth_schema(conn)
        return await conn.fetch(
            f"""
            SELECT credential_id, user_id, public_key, sign_count, transports
            FROM {AUTH_CREDENTIAL_PG_TABLE}
            WHERE user_id = $1
            ORDER BY created_at ASC
            """,
            user_id,
        )


async def increment_passkey_sign_count(credential_id: str, pg_pool: Any = None) -> None:
    """Increment the sign counter for a credential after a successful assertion."""
    pool = pg_pool or get_auth_pg_pool()
    async with pool.acquire() as conn:
        await _ensure_auth_schema(conn)
        await conn.execute(
            f"""
            UPDATE {AUTH_CREDENTIAL_PG_TABLE}
            SET sign_count = sign_count + 1, last_used_at = now()
            WHERE credential_id = $1
            """,
            credential_id,
        )
