"""Redis-backed authentication challenge nonces."""

from __future__ import annotations

import os
import secrets
from typing import Any

AUTH_CHALLENGE_TTL_SECONDS = 180
AUTH_CHALLENGE_REDIS_KEY = "stellarflow:auth:challenge"

_redis_client: Any = None

_CONSUME_CHALLENGE_SCRIPT = """
local value = redis.call('GET', KEYS[1])
if value == ARGV[1] then
  redis.call('DEL', KEYS[1])
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
        ex=AUTH_CHALLENGE_TTL_SECONDS,
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