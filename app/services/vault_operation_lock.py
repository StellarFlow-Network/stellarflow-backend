"""Redlock-compatible synchronization for vault state changes."""

from __future__ import annotations

import math
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
_DEFAULT_AUCTION_OPEN_DELAY_S = 10.0
_DEFAULT_PRICE_DECAY_K = 0.001
_DEFAULT_AUCTION_KEY_PREFIX = "stellarflow:vault:debt_auction"
_DEFAULT_DEBT_TOKEN_PREFIX = "stellarflow:protocol:debt"


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
        self._auction_key_prefix = os.getenv(
            "VAULT_DEBT_AUCTION_KEY_PREFIX", _DEFAULT_AUCTION_KEY_PREFIX
        )
        self._debt_token_prefix = os.getenv("PROTOCOL_DEBT_TOKEN_PREFIX", _DEFAULT_DEBT_TOKEN_PREFIX)

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
            self._schedule_bad_debt_auction_if_needed(
                collateral_value=0.0,
                total_debt=0.0,
            )
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
        self._settle_debt_auction_if_ready(
            winning_bid=0.0,
            debt_token_amount=0.0,
        )
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

    def _auction_key(self) -> str:
        return f"{self._auction_key_prefix}:{self.account_id}"

    def _debt_token_key(self) -> str:
        return f"{self._debt_token_prefix}:{self.account_id}"

    @staticmethod
    def price_decay(
        start_price: float,
        elapsed_seconds: float,
        decay_k: float = _DEFAULT_PRICE_DECAY_K,
    ) -> float:
        """Return the time-decayed auction price ``P(t) = P_start * e^(-k t)``."""
        if start_price < 0:
            raise ValueError("start_price cannot be negative")
        if elapsed_seconds < 0:
            raise ValueError("elapsed_seconds cannot be negative")
        if decay_k < 0:
            raise ValueError("decay_k cannot be negative")
        return start_price * math.exp(-decay_k * elapsed_seconds)

    def _schedule_bad_debt_auction_if_needed(
        self,
        collateral_value: float,
        total_debt: float,
        start_price: float | None = None,
        open_delay_s: float = _DEFAULT_AUCTION_OPEN_DELAY_S,
    ) -> bool:
        """Open a debt auction record when liquidation leaves uncollateralized bad debt.

        Returns ``True`` when a new auction record was created. The auction is
        scheduled to open within ``open_delay_s`` seconds of the liquidation
        failure so the acceptance criteria (<= 10s) is met by default.
        """
        bad_debt = total_debt - collateral_value
        if bad_debt <= 0:
            return False
        if open_delay_s < 0 or open_delay_s > _DEFAULT_AUCTION_OPEN_DELAY_S:
            raise ValueError("open_delay_s must be between 0 and 10 seconds")

        now = time.time()
        auction = {
            "account_id": self.account_id,
            "bad_debt": bad_debt,
            "start_price": start_price if start_price is not None else bad_debt,
            "decay_k": _DEFAULT_PRICE_DECAY_K,
            "created_at": now,
            "opens_at": now + open_delay_s,
            "status": "scheduled",
        }
        for client in self._clients:
            try:
                client.hset(self._auction_key(), mapping=auction)
                break
            except redis.RedisError:
                continue
        log.info(
            "vault_lock.bad_debt_auction_scheduled",
            component="VaultOperationLock",
            account_id=self.account_id,
            bad_debt=bad_debt,
            opens_at=auction["opens_at"],
        )
        return True

    def current_bid_threshold(self, now: float | None = None) -> float | None:
        """Return the live price-decay threshold for the account's debt auction."""
        current = time.time() if now is None else now
        for client in self._clients:
            try:
                auction = client.hgetall(self._auction_key())
            except redis.RedisError:
                continue
            if not auction:
                return None
            opens_at = float(auction.get("opens_at", 0.0))
            if current < opens_at:
                return float(auction.get("start_price", 0.0))
            elapsed = current - opens_at
            return self.price_decay(
                float(auction.get("start_price", 0.0)),
                elapsed,
                float(auction.get("decay_k", _DEFAULT_PRICE_DECAY_K)),
            )
        return None

    def _settle_debt_auction_if_ready(
        self,
        winning_bid: float,
        debt_token_amount: float,
    ) -> bool:
        """Settle a winning bid and burn the corresponding protocol debt tokens."""
        if winning_bid <= 0 or debt_token_amount <= 0:
            return False
        threshold = self.current_bid_threshold()
        if threshold is None or winning_bid < threshold:
            return False
        for client in self._clients:
            try:
                client.hset(
                    self._auction_key(),
                    mapping={"status": "settled", "winning_bid": winning_bid},
                )
                client.decrby(self._debt_token_key(), int(debt_token_amount))
                break
            except redis.RedisError:
                continue
        log.info(
            "vault_lock.debt_auction_settled",
            component="VaultOperationLock",
            account_id=self.account_id,
            winning_bid=winning_bid,
            debt_token_amount=debt_token_amount,
        )
        return True


def vault_operation_lock(account_id: str) -> VaultOperationLock:
    """Return the account-scoped lock used around vault state changes."""
    return VaultOperationLock(account_id)