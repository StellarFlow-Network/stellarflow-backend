"""Ownership-safe distributed Redis lock for nullifier-tree writes."""

from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass
from typing import Any

import redis.asyncio as redis


class LockAcquireTimeout(RuntimeError):
    """Raised when a lock cannot be acquired within the configured wait period."""


_RELEASE_SCRIPT = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""


@dataclass(frozen=True)
class NullifierLockSettings:
    key_prefix: str = "stellarflow:nullifier-tree"
    lease_ms: int = 15_000
    wait_timeout_ms: int = 2_000
    retry_interval_ms: int = 50


class NullifierTreeLock:
    """Redis SET NX PX lock with token-checked release."""

    def __init__(
        self,
        client: redis.Redis,
        tree_id: str,
        settings: NullifierLockSettings | None = None,
    ) -> None:
        self.client = client
        self.tree_id = tree_id
        self.settings = settings or NullifierLockSettings()
        self.key = f"{self.settings.key_prefix}:{tree_id}"
        self.token: str | None = None

    async def acquire(self) -> None:
        deadline = asyncio.get_running_loop().time() + (
            self.settings.wait_timeout_ms / 1000
        )
        token = secrets.token_urlsafe(32)

        while asyncio.get_running_loop().time() < deadline:
            acquired = await self.client.set(
                self.key,
                token,
                nx=True,
                px=self.settings.lease_ms,
            )
            if acquired:
                self.token = token
                return
            await asyncio.sleep(self.settings.retry_interval_ms / 1000)

        raise LockAcquireTimeout(f"Could not acquire nullifier-tree lock: {self.key}")

    async def release(self) -> None:
        if self.token is None:
            return
        await self.client.eval(_RELEASE_SCRIPT, 1, self.key, self.token)
        self.token = None

    async def __aenter__(self) -> "NullifierTreeLock":
        await self.acquire()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.release()
