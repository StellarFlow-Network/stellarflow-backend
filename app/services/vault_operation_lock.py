"""Redlock-compatible synchronization for vault state changes."""

from __future__ import annotations

import os
import secrets
import time
from collections.abc import Sequence
from contextlib import AbstractContextManager
from typing import Any

import redis
import structlog

log = structlog.get_logger(__name__)


_RELEASE_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
"""
_DEFAULT_TTL_MS = 30_000
_DEFAULT_RETRY_DELAY_MS = 100
_DEFAULT_RETRIES = 3


class VaultLockError(RuntimeError):
    """Raised when a vault operation cannot obtain its account lock."""


class VaultOperationLock(AbstractContextManager["VaultOperationLock"]):
    """Acquire a quorum lock for one account using the Redlock algorithm.

    The lock is released only when the stored random token matches. If a
    worker dies, Redis expires the key after ``ttl_ms`` and prevents a
    permanent deadlock.
    """

    def __init__(
        self,
        account_id: str,
        redis_clients: Sequence[redis.Redis[Any]] | None = None,
        ttl_ms: int = _DEFAULT_TTL_MS,
        retry_delay_ms: int = _DEFAULT_RETRY_DELAY_MS,
        retries: int = _DEFAULT_RETRIES,
    ) -> None:
        if not isinstance(account_id, str) or not account_id.strip():
            raise ValueError("account_id must be a non-empty string")
        if ttl_ms < 1:
            raise ValueError("ttl_ms must be positive")
        if retry_delay_ms < 0 or retries < 0:
            raise ValueError("retry_delay_ms and retries cannot be negative")

        self.account_id = account_id.strip()
        self._clients = list(redis_clients or self._clients_from_environment())
        if not self._clients:
            raise ValueError("At least one Redis client is required")
        self._ttl_ms = ttl_ms
        self._retry_delay_ms = retry_delay_ms
        self._retries = retries
        self._key = f"{os.getenv('VAULT_LOCK_KEY_PREFIX', 'stellarflow:vault:lock')}:{self.account_id}"
        self._token = secrets.token_urlsafe(32)
        self._acquired_clients: list[redis.Redis[Any]] = []

    @staticmethod
    def _clients_from_environment() -> list[redis.Redis[Any]]:
        configured_urls = os.getenv("REDLOCK_REDIS_URLS", os.getenv("REDIS_URL", "redis://localhost:6379/0"))
        return [
            redis.Redis.from_url(redis_url.strip(), decode_responses=True)
            for redis_url in configured_urls.split(",")
            if redis_url.strip()
        ]

    def __enter__(self) -> "VaultOperationLock":
        quorum = len(self._clients) // 2 + 1
        for attempt in range(self._retries + 1):
            start_time = time.monotonic()
            acquired_clients: list[redis.Redis[Any]] = []
            for client in self._clients:
                try:
                    if client.set(self._key, self._token, nx=True, px=self._ttl_ms):
                        acquired_clients.append(client)
                except redis.RedisError:
                    continue

            elapsed_ms = (time.monotonic() - start_time) * 1000
            validity_ms = self._ttl_ms - elapsed_ms - max(1, int(self._ttl_ms * 0.01))
            if len(acquired_clients) >= quorum and validity_ms > 0:
                self._acquired_clients = acquired_clients
                log.debug(
                    "vault_lock.acquired",
                    component="VaultOperationLock",
                    account_id=self.account_id,
                    attempt=attempt + 1,
                    quorum=quorum,
                    validity_ms=round(validity_ms, 1),
                )
                return self

            self._release_clients(acquired_clients)
            if attempt < self._retries:
                log.warning(
                    "vault_lock.acquire_attempt_failed",
                    component="VaultOperationLock",
                    account_id=self.account_id,
                    attempt=attempt + 1,
                    retries=self._retries,
                    acquired=len(acquired_clients),
                    quorum=quorum,
                )
                time.sleep(self._retry_delay_ms / 1000)

        log.error(
            "vault_lock.acquire_exhausted",
            component="VaultOperationLock",
            account_id=self.account_id,
            retries=self._retries,
        )
        raise VaultLockError(f"Could not acquire vault lock for account {self.account_id}")

    def __exit__(self, exc_type: Any, exc_value: Any, traceback: Any) -> None:
        self.release()

    def release(self) -> None:
        """Release the lock safely; expired or already-released locks are ignored."""
        acquired_clients = self._acquired_clients
        self._acquired_clients = []
        self._release_clients(acquired_clients)
        log.debug(
            "vault_lock.released",
            component="VaultOperationLock",
            account_id=self.account_id,
        )

    def _release_clients(self, clients: Sequence[redis.Redis[Any]]) -> None:
        for client in clients:
            try:
                client.eval(_RELEASE_SCRIPT, 1, self._key, self._token)
            except redis.RedisError:
                continue


def vault_operation_lock(account_id: str) -> VaultOperationLock:
    """Return the account-scoped lock used around vault state changes."""
    return VaultOperationLock(account_id)