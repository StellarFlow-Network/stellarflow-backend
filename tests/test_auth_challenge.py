from __future__ import annotations

import asyncio
import time

from app.services.auth_challenge import (
    AUTH_CHALLENGE_REDIS_KEY,
    AUTH_CHALLENGE_TTL_SECONDS,
    consume_auth_challenge,
    create_auth_challenge,
)


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.expiry: dict[str, float] = {}
        self.set_calls: list[tuple[str, str, int]] = []

    async def set(self, key: str, value: str, *, ex: int) -> bool:
        self.values[key] = value
        self.expiry[key] = time.monotonic() + ex
        self.set_calls.append((key, value, ex))
        return True

    async def eval(self, _script: str, _num_keys: int, key: str, nonce: str) -> int:
        if self.expiry.get(key, 0) <= time.monotonic():
            self.values.pop(key, None)
            return 0
        if self.values.get(key) != nonce:
            return 0
        del self.values[key]
        return 1


def test_challenge_is_32_bytes_and_has_exact_three_minute_ttl() -> None:
    redis = FakeRedis()

    nonce = asyncio.run(create_auth_challenge(redis))

    assert len(bytes.fromhex(nonce)) == 32
    assert redis.set_calls == [
        (AUTH_CHALLENGE_REDIS_KEY, nonce, AUTH_CHALLENGE_TTL_SECONDS)
    ]


def test_challenge_can_only_be_consumed_once() -> None:
    redis = FakeRedis()
    nonce = asyncio.run(create_auth_challenge(redis))

    assert asyncio.run(consume_auth_challenge(nonce, redis)) is True
    assert asyncio.run(consume_auth_challenge(nonce, redis)) is False
    assert asyncio.run(consume_auth_challenge("wrong", redis)) is False