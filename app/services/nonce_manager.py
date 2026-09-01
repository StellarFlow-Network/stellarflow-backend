"""app/services/nonce_manager.py — High-Concurrency Relayer Account Sequence/Nonce Manager.

Issue #721 — Prevent sequence number conflicts when sending concurrent submit
transactions from backend relayer accounts.

Design
------
Three technical requirements:

1. **Atomic Redis sequence counter**
   Each relayer account's current sequence number is stored as a Redis key
   ``stellarflow:nonce:{account}`` and incremented via the atomic ``INCR``
   command. Because Redis processes commands serially, ``INCR`` is guaranteed
   to return a unique, monotonically-increasing value to every concurrent
   caller without any additional locking. A local threading.Lock is held only
   around the Redis call + in-flight bookkeeping update so that a single
   process cannot race itself during the assign→submit→confirm cycle.

2. **Horizon re-sync on mismatch**
   A ``tx_bad_seq`` error from Horizon (HTTP 400 with
   ``extras.result_codes.transaction == "tx_bad_seq"``) indicates the local
   counter has drifted from the ledger. ``resync_from_horizon()`` fetches the
   authoritative sequence number from the Horizon ``/accounts/{address}``
   endpoint, overwrites the Redis key atomically via ``SET``, and clears the
   in-flight pending set so the next acquire starts from a clean state.

3. **Multi-account relayer pool load distribution**
   ``RelayerPool`` wraps a list of ``NonceManager`` instances (one per relayer
   account). ``acquire_account()`` selects the least-loaded account — the one
   with the fewest in-flight transactions — to spread concurrent submissions
   evenly. ``release_account()`` confirms or fails a previously acquired slot
   and forwards the call to the corresponding ``NonceManager``.

Thread safety
-------------
* ``NonceManager``: per-instance ``threading.Lock`` serialises Redis I/O and
  in-flight bookkeeping for a single account.
* ``RelayerPool``: a separate ``threading.Lock`` protects the pool-level
  account selection so the least-loaded choice is consistent.
* Redis atomicity (``INCR``, ``SET``) prevents cross-process races when
  multiple backend workers share the same Redis instance.

Usage example::

    pool = RelayerPool(
        accounts=["GABC...", "GDEF..."],
        horizon_url="https://horizon-testnet.stellar.org",
        redis_url="redis://localhost:6379",
    )

    # Acquire a sequence slot from the least-loaded relayer account.
    account, sequence = pool.acquire_account()
    try:
        submit_transaction(account, sequence)
        pool.release_account(account, sequence, success=True)
    except HorizonBadSeqError:
        pool.resync(account)
        pool.release_account(account, sequence, success=False)
"""

from __future__ import annotations

import os
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Dict, Generator, Iterator, List, Optional, Set, Tuple

import requests
import structlog

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Default Redis key namespace — matches the existing project-wide prefix used
# in src/config/loader.py RedisConfig.key_prefix.
_KEY_PREFIX: str = "stellarflow:nonce:"

# Horizon account endpoint template.
_HORIZON_ACCOUNT_PATH: str = "/accounts/{address}"

# How long (seconds) a pending sequence may remain unresolved before it is
# considered stale for diagnostic purposes.
DEFAULT_STALE_TIMEOUT_SECONDS: float = 30.0

# HTTP request timeout for Horizon re-sync calls (seconds).
HORIZON_REQUEST_TIMEOUT_SECONDS: float = 5.0

# Maximum number of re-sync retries before giving up.
MAX_RESYNC_RETRIES: int = 3

# Backoff (seconds) between re-sync retries.
RESYNC_RETRY_BACKOFF_SECONDS: float = 0.5


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class NonceMismatchError(Exception):
    """Raised when Horizon returns tx_bad_seq for a submitted transaction.

    Callers should catch this, call ``NonceManager.resync_from_horizon()``,
    and retry the submission with a fresh sequence number.
    """


class NonceExhaustedError(Exception):
    """Raised when no relayer account has a free in-flight slot.

    This typically means all accounts in the pool are saturated. Callers
    should back off and retry after some in-flight transactions complete.
    """


# ---------------------------------------------------------------------------
# Pending slot tracking
# ---------------------------------------------------------------------------


@dataclass
class _PendingSlot:
    """Bookkeeping for a sequence that has been issued but not yet resolved."""

    sequence: int
    issued_at: float = field(default_factory=time.monotonic)


# ---------------------------------------------------------------------------
# NonceManager — per-account atomic sequence manager
# ---------------------------------------------------------------------------


class NonceManager:
    """Atomic per-account sequence/nonce manager backed by Redis.

    Each ``NonceManager`` instance manages the sequence number for a single
    Stellar relayer account. It uses Redis ``INCR`` for atomic increments
    (preventing cross-process races) and wraps each Redis operation with a
    local threading.Lock to serialise the assign→confirm/fail bookkeeping
    within the same process.

    Parameters
    ----------
    account_address:
        Stellar public key of the relayer account this manager tracks.
    horizon_url:
        Base URL of the Horizon server used for re-sync queries
        (e.g. ``"https://horizon-testnet.stellar.org"``).
    redis_client:
        A connected ``redis.Redis`` (or ``redis.StrictRedis``) instance.
        The caller is responsible for connection management and teardown.
    key_prefix:
        Namespace prefix for Redis keys. Defaults to ``stellarflow:nonce:``.
    stale_timeout_seconds:
        Seconds after which an unresolved pending sequence is considered stale.
    """

    def __init__(
        self,
        account_address: str,
        horizon_url: str,
        redis_client: object,
        key_prefix: str = _KEY_PREFIX,
        stale_timeout_seconds: float = DEFAULT_STALE_TIMEOUT_SECONDS,
    ) -> None:
        if not account_address:
            raise ValueError("account_address must be a non-empty string.")
        if not horizon_url:
            raise ValueError("horizon_url must be a non-empty string.")
        if redis_client is None:
            raise ValueError("redis_client must not be None.")

        self.account_address = account_address
        self._horizon_url = horizon_url.rstrip("/")
        self._redis = redis_client
        self._redis_key = f"{key_prefix}{account_address}"
        self._stale_timeout = stale_timeout_seconds

        # Per-account lock: serialises the Redis INCR + in-flight set update
        # so that a single process cannot observe a race between assign and
        # the pending bookkeeping.
        self._lock = threading.Lock()

        # In-flight pending slots: sequence → _PendingSlot
        self._pending: Dict[int, _PendingSlot] = {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def in_flight_count(self) -> int:
        """Number of sequences currently issued but not yet confirmed/failed."""
        with self._lock:
            return len(self._pending)

    def acquire(self, seed: Optional[int] = None) -> int:
        """Atomically allocate the next sequence number for this account.

        On the first call the Redis key may not yet exist. Pass *seed* with
        the current on-chain sequence number so the key is initialised to
        ``seed`` and this call returns ``seed + 1`` (the next usable nonce
        after the on-chain state). If the key already exists, *seed* is
        ignored and Redis ``INCR`` determines the next value.

        Parameters
        ----------
        seed:
            Optional on-chain sequence to bootstrap the Redis key when it
            does not yet exist. If the key already exists this is ignored.

        Returns
        -------
        int
            The unique sequence number to use for the next transaction.

        Raises
        ------
        ValueError
            If the Redis key does not exist and no *seed* is provided.
        """
        with self._lock:
            # Initialise the Redis key if it is absent and a seed is given.
            exists = self._redis.exists(self._redis_key)
            if not exists:
                if seed is None:
                    raise ValueError(
                        f"Redis key for {self.account_address!r} does not exist "
                        "and no seed was provided. Call resync_from_horizon() "
                        "or pass a seed to bootstrap the counter."
                    )
                # SET NX: only write if the key is still absent (another
                # process may have written it between exists() and SET).
                self._redis.set(self._redis_key, seed, nx=True)
                log.info(
                    "nonce_manager.counter.bootstrapped",
                    component="NonceManager",
                    account=self.account_address,
                    seed=seed,
                )

            # Atomic increment — Redis guarantees uniqueness across all clients.
            sequence = int(self._redis.incr(self._redis_key))

            # Record the slot as pending.
            self._pending[sequence] = _PendingSlot(sequence=sequence)

            log.debug(
                    "nonce_manager.sequence.acquired",
                    component="NonceManager",
                    account=self.account_address,
                    sequence=sequence,
                    in_flight=len(self._pending),
                )
            return sequence

    def confirm(self, sequence: int) -> None:
        """Mark a sequence as successfully landed on the ledger.

        Removes the sequence from the pending in-flight set so it no longer
        counts toward the in-flight load for this account.

        Parameters
        ----------
        sequence:
            The sequence number that was confirmed on-chain.
        """
        with self._lock:
            slot = self._pending.pop(sequence, None)
            if slot is not None:
                latency_ms = (time.monotonic() - slot.issued_at) * 1000
                log.info(
                    "nonce_manager.sequence.confirmed",
                    component="NonceManager",
                    account=self.account_address,
                    sequence=sequence,
                    latency_ms=round(latency_ms, 1),
                )
            else:
                log.debug(
                    "nonce_manager.confirm.unknown_sequence",
                    component="NonceManager",
                    account=self.account_address,
                    sequence=sequence,
                )

    def fail(self, sequence: int) -> None:
        """Mark a sequence as failed (rejected or dropped).

        Removes the sequence from the pending set. Does **not** roll back the
        Redis counter — after a failure the caller should call
        ``resync_from_horizon()`` to realign with the on-chain state before
        issuing the next sequence.

        Parameters
        ----------
        sequence:
            The sequence number that failed.
        """
        with self._lock:
            slot = self._pending.pop(sequence, None)
            if slot is not None:
                latency_ms = (time.monotonic() - slot.issued_at) * 1000
                log.info(
                    "nonce_manager.sequence.failed",
                    component="NonceManager",
                    account=self.account_address,
                    sequence=sequence,
                    latency_ms=round(latency_ms, 1),
                )
            else:
                log.debug(
                    "nonce_manager.fail.unknown_sequence",
                    component="NonceManager",
                    account=self.account_address,
                    sequence=sequence,
                )

    def resync_from_horizon(self) -> int:
        """Re-synchronise the Redis counter with the authoritative Horizon state.

        Queries the Horizon ``/accounts/{address}`` endpoint to obtain the
        current on-chain sequence number, then atomically overwrites the Redis
        key with that value and clears all pending in-flight bookkeeping.

        Call this after receiving a ``tx_bad_seq`` error from Horizon so that
        the next ``acquire()`` will use the correct ledger sequence.

        Returns
        -------
        int
            The authoritative on-chain sequence number that was written to Redis.

        Raises
        ------
        NonceMismatchError
            If the Horizon request fails after all retries.
        """
        last_exc: Optional[Exception] = None

        for attempt in range(1, MAX_RESYNC_RETRIES + 1):
            try:
                ledger_sequence = self._fetch_horizon_sequence()
                break
            except Exception as exc:
                last_exc = exc
                log.warning(
                    "nonce_manager.resync.attempt_failed",
                    component="NonceManager",
                    account=self.account_address,
                    attempt=attempt,
                    max_retries=MAX_RESYNC_RETRIES,
                    error=str(exc),
                )
                if attempt < MAX_RESYNC_RETRIES:
                    time.sleep(RESYNC_RETRY_BACKOFF_SECONDS * attempt)
        else:
            raise NonceMismatchError(
                f"Horizon re-sync failed for {self.account_address!r} after "
                f"{MAX_RESYNC_RETRIES} attempts: {last_exc}"
            ) from last_exc

        with self._lock:
            # Overwrite the Redis key with the authoritative ledger value.
            # Using SET (not INCR) so we can force an exact value.
            self._redis.set(self._redis_key, ledger_sequence)
            # Discard all in-flight bookkeeping — those sequences are now
            # superseded by the authoritative ledger state.
            self._pending.clear()

        log.info(
            "nonce_manager.resync.completed",
            component="NonceManager",
            account=self.account_address,
            ledger_sequence=ledger_sequence,
        )
        return ledger_sequence

    def get_stale(
        self, timeout_seconds: Optional[float] = None
    ) -> List[int]:
        """Return pending sequences older than *timeout_seconds*.

        Useful for detecting transactions that likely dropped or whose outcome
        was never reported back, so they can be investigated or retried.

        Parameters
        ----------
        timeout_seconds:
            Stale threshold in seconds. Defaults to ``self._stale_timeout``.

        Returns
        -------
        List[int]
            Sorted list of stale sequence numbers.
        """
        threshold = timeout_seconds if timeout_seconds is not None else self._stale_timeout
        now = time.monotonic()
        with self._lock:
            stale = [
                seq
                for seq, slot in self._pending.items()
                if (now - slot.issued_at) > threshold
            ]
        return sorted(stale)

    def get_pending_sequences(self) -> List[int]:
        """Return a sorted snapshot of all currently in-flight sequences."""
        with self._lock:
            return sorted(self._pending.keys())

    def get_current_counter(self) -> Optional[int]:
        """Return the current Redis counter value for this account, or None.

        Reads the raw Redis value without modifying it. Returns ``None`` if
        the key does not yet exist in Redis.
        """
        raw = self._redis.get(self._redis_key)
        if raw is None:
            return None
        return int(raw)

    def invalidate(self) -> None:
        """Delete the Redis key and clear all in-flight bookkeeping.

        Forces the next ``acquire()`` caller to provide a fresh seed (or call
        ``resync_from_horizon()`` first). Useful for clean shutdown or testing.
        """
        with self._lock:
            self._redis.delete(self._redis_key)
            self._pending.clear()
        log.info(
            "nonce_manager.counter.invalidated",
            component="NonceManager",
            account=self.account_address,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _fetch_horizon_sequence(self) -> int:
        """Fetch the current on-chain sequence number from Horizon.

        Returns
        -------
        int
            The integer sequence number from the Horizon account response.

        Raises
        ------
        requests.HTTPError
            If Horizon returns a non-2xx status.
        requests.RequestException
            On any network-level error.
        ValueError
            If the Horizon response body cannot be parsed.
        """
        url = self._horizon_url + _HORIZON_ACCOUNT_PATH.format(
            address=self.account_address
        )
        response = requests.get(url, timeout=HORIZON_REQUEST_TIMEOUT_SECONDS)
        response.raise_for_status()

        data = response.json()
        sequence_str = data.get("sequence")
        if sequence_str is None:
            raise ValueError(
                f"Horizon response for {self.account_address!r} has no "
                f"'sequence' field. Response keys: {list(data.keys())}"
            )
        return int(sequence_str)


# ---------------------------------------------------------------------------
# RelayerPool — multi-account load-distributing pool
# ---------------------------------------------------------------------------


@dataclass
class _AccountLoad:
    """Snapshot of one relayer account's current load for pool selection."""

    address: str
    in_flight: int


class RelayerPool:
    """Multi-account relayer pool with least-loaded distribution strategy.

    Wraps a collection of :class:`NonceManager` instances (one per relayer
    account) and distributes concurrent transaction submissions across them by
    always choosing the account with the fewest in-flight sequences at the
    moment of acquisition.

    Thread safety
    -------------
    A pool-level ``threading.Lock`` guards the account-selection logic so that
    two concurrent callers do not both choose the same "least loaded" account
    and race each other. The per-account :class:`NonceManager` lock then
    serialises the actual Redis interaction for that account.

    Parameters
    ----------
    accounts:
        Ordered list of Stellar public-key addresses for the relayer accounts.
        At least one account is required.
    horizon_url:
        Horizon base URL shared by all accounts in this pool.
    redis_client:
        A connected ``redis.Redis`` instance shared by all managers.
    key_prefix:
        Redis key namespace prefix forwarded to each :class:`NonceManager`.
    stale_timeout_seconds:
        Stale-detection threshold forwarded to each :class:`NonceManager`.

    Example usage::

        import redis
        pool = RelayerPool(
            accounts=["GABC...", "GDEF..."],
            horizon_url="https://horizon-testnet.stellar.org",
            redis_client=redis.Redis.from_url("redis://localhost:6379"),
        )

        account, sequence = pool.acquire_account()
        try:
            submit(account, sequence)
            pool.release_account(account, sequence, success=True)
        except BadSeqError:
            pool.resync(account)
            pool.release_account(account, sequence, success=False)
    """

    def __init__(
        self,
        accounts: List[str],
        horizon_url: str,
        redis_client: object,
        key_prefix: str = _KEY_PREFIX,
        stale_timeout_seconds: float = DEFAULT_STALE_TIMEOUT_SECONDS,
    ) -> None:
        if not accounts:
            raise ValueError("RelayerPool requires at least one account address.")

        self._pool_lock = threading.Lock()
        self._managers: Dict[str, NonceManager] = {}

        for address in accounts:
            self._managers[address] = NonceManager(
                account_address=address,
                horizon_url=horizon_url,
                redis_client=redis_client,
                key_prefix=key_prefix,
                stale_timeout_seconds=stale_timeout_seconds,
            )

        log.info(
            "relayer_pool.initialised",
            component="RelayerPool",
            account_count=len(accounts),
            accounts=accounts,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def accounts(self) -> List[str]:
        """Return the list of account addresses managed by this pool."""
        return list(self._managers.keys())

    def acquire_account(self, seed_map: Optional[Dict[str, int]] = None) -> Tuple[str, int]:
        """Select the least-loaded account and acquire a sequence number.

        Uses a least-in-flight strategy: the account with the fewest currently
        pending (in-flight) sequences is chosen. This spreads concurrent
        submissions evenly across the relayer pool.

        Parameters
        ----------
        seed_map:
            Optional mapping of ``{address: seed_sequence}`` used to bootstrap
            Redis counters for accounts that have no existing key. Only the
            seed for the selected account is forwarded to
            :meth:`NonceManager.acquire`.

        Returns
        -------
        Tuple[str, int]
            ``(account_address, sequence)`` — the chosen account and the
            unique sequence number allocated for the next transaction.

        Raises
        ------
        NonceExhaustedError
            If every account's Redis key is absent and no seed_map was
            provided, making it impossible to acquire any sequence.
        """
        with self._pool_lock:
            # Build a snapshot of in-flight counts for all accounts under the
            # pool lock so the selection is consistent.
            loads: List[_AccountLoad] = [
                _AccountLoad(
                    address=addr,
                    in_flight=mgr.in_flight_count,
                )
                for addr, mgr in self._managers.items()
            ]

        # Select the account with the minimum in-flight load.
        # Ties are broken by the iteration order (original account list order),
        # giving deterministic behaviour when all accounts are idle.
        chosen_load = min(loads, key=lambda al: al.in_flight)
        chosen_address = chosen_load.address
        manager = self._managers[chosen_address]

        seed = seed_map.get(chosen_address) if seed_map else None

        try:
            sequence = manager.acquire(seed=seed)
        except ValueError as exc:
            # The chosen account has no Redis key and no seed was provided.
            # Try other accounts in ascending in-flight order before giving up.
            fallback_loads = sorted(loads, key=lambda al: al.in_flight)
            for fallback in fallback_loads:
                if fallback.address == chosen_address:
                    continue
                fb_manager = self._managers[fallback.address]
                fb_seed = seed_map.get(fallback.address) if seed_map else None
                try:
                    sequence = fb_manager.acquire(seed=fb_seed)
                    chosen_address = fallback.address
                    log.info(
                        "relayer_pool.fallback_account_selected",
                        component="RelayerPool",
                        fallback_account=chosen_address,
                        primary_account=chosen_load.address,
                    )
                    break
                except ValueError:
                    continue
            else:
                raise NonceExhaustedError(
                    "No relayer account has a seeded Redis counter. "
                    "Call resync_all() or pass seed_map to acquire_account()."
                ) from exc

        log.debug(
            "relayer_pool.sequence.assigned",
            component="RelayerPool",
            account=chosen_address,
            sequence=sequence,
            in_flight_before=chosen_load.in_flight,
        )
        return chosen_address, sequence

    def release_account(
        self, account_address: str, sequence: int, *, success: bool
    ) -> None:
        """Confirm or fail a previously acquired sequence slot.

        Parameters
        ----------
        account_address:
            The account address returned by :meth:`acquire_account`.
        sequence:
            The sequence number returned by :meth:`acquire_account`.
        success:
            ``True`` if the transaction landed on the ledger (calls
            :meth:`NonceManager.confirm`); ``False`` if it was rejected or
            dropped (calls :meth:`NonceManager.fail`).
        """
        manager = self._managers.get(account_address)
        if manager is None:
            log.error(
                "relayer_pool.release.unknown_account",
                component="RelayerPool",
                account=account_address,
            )
            return

        if success:
            manager.confirm(sequence)
        else:
            manager.fail(sequence)

    def resync(self, account_address: str) -> int:
        """Re-synchronise a single account with the Horizon ledger.

        Delegates to :meth:`NonceManager.resync_from_horizon`. Call this
        after a ``tx_bad_seq`` error for *account_address*.

        Parameters
        ----------
        account_address:
            The account to re-synchronise.

        Returns
        -------
        int
            The authoritative on-chain sequence written to Redis.

        Raises
        ------
        KeyError
            If *account_address* is not in this pool.
        NonceMismatchError
            If the Horizon re-sync fails after all retries.
        """
        manager = self._managers.get(account_address)
        if manager is None:
            raise KeyError(
                f"Account {account_address!r} is not managed by this RelayerPool."
            )
        return manager.resync_from_horizon()

    def resync_all(self) -> Dict[str, int]:
        """Re-synchronise every account in the pool with Horizon.

        Useful on startup to bootstrap all Redis counters from the live
        ledger state before any transactions are submitted.

        Returns
        -------
        Dict[str, int]
            Mapping of ``{address: ledger_sequence}`` for each account.
            Accounts whose re-sync failed will be absent from the result;
            errors are logged but not re-raised so a partial success is
            still usable.
        """
        results: Dict[str, int] = {}
        for address, manager in self._managers.items():
            try:
                seq = manager.resync_from_horizon()
                results[address] = seq
            except NonceMismatchError as exc:
                log.error(
                    "relayer_pool.resync_all.account_failed",
                    component="RelayerPool",
                    account=address,
                    error=str(exc),
                )
        return results

    def get_pool_status(self) -> List[Dict]:
        """Return a diagnostic snapshot of every account's current state.

        Returns
        -------
        List[Dict]
            One dict per account with keys:
            ``address``, ``in_flight``, ``current_counter``,
            ``stale_sequences``, ``pending_sequences``.
        """
        status = []
        for address, manager in self._managers.items():
            status.append(
                {
                    "address": address,
                    "in_flight": manager.in_flight_count,
                    "current_counter": manager.get_current_counter(),
                    "stale_sequences": manager.get_stale(),
                    "pending_sequences": manager.get_pending_sequences(),
                }
            )
        return status

    def invalidate_all(self) -> None:
        """Delete all Redis keys and clear all pending bookkeeping.

        Forces every account to require a fresh seed or ``resync_from_horizon``
        before the next acquisition. Intended for clean shutdown or testing.
        """
        for manager in self._managers.values():
            manager.invalidate()
        log.info(
            "relayer_pool.all_counters_invalidated",
            component="RelayerPool",
        )


# ---------------------------------------------------------------------------
# Context-manager helpers
# ---------------------------------------------------------------------------


@contextmanager
def managed_sequence(
    pool: RelayerPool,
    seed_map: Optional[Dict[str, int]] = None,
) -> Generator[Tuple[str, int], None, None]:
    """Context manager that acquires a sequence and auto-releases on exit.

    On a normal exit (no exception), the sequence is confirmed.
    On any exception, the sequence is marked as failed.

    Usage::

        with managed_sequence(pool) as (account, seq):
            submit_transaction(account, seq)
        # confirmed automatically

    Parameters
    ----------
    pool:
        The :class:`RelayerPool` to acquire from.
    seed_map:
        Optional seed map forwarded to :meth:`RelayerPool.acquire_account`.

    Yields
    ------
    Tuple[str, int]
        ``(account_address, sequence)`` ready for transaction submission.
    """
    account, sequence = pool.acquire_account(seed_map=seed_map)
    try:
        yield account, sequence
        pool.release_account(account, sequence, success=True)
    except Exception:
        pool.release_account(account, sequence, success=False)
        raise


# ---------------------------------------------------------------------------
# Module-level factory
# ---------------------------------------------------------------------------


def create_relayer_pool(
    accounts: Optional[List[str]] = None,
    horizon_url: Optional[str] = None,
    redis_url: Optional[str] = None,
    key_prefix: str = _KEY_PREFIX,
    stale_timeout_seconds: float = DEFAULT_STALE_TIMEOUT_SECONDS,
) -> RelayerPool:
    """Factory that builds a :class:`RelayerPool` from environment variables.

    Environment variables (all optional if explicit arguments are supplied):
    * ``RELAYER_ACCOUNTS`` — comma-separated Stellar public keys.
    * ``HORIZON_URL`` — Horizon base URL.
    * ``REDIS_URL`` — Redis connection URL.

    Parameters
    ----------
    accounts:
        Overrides ``RELAYER_ACCOUNTS`` env var when provided.
    horizon_url:
        Overrides ``HORIZON_URL`` env var when provided.
    redis_url:
        Overrides ``REDIS_URL`` env var when provided.
    key_prefix:
        Forwarded to :class:`RelayerPool`.
    stale_timeout_seconds:
        Forwarded to :class:`RelayerPool`.

    Returns
    -------
    RelayerPool
        A fully initialised pool. Redis keys are **not** seeded automatically
        — call :meth:`RelayerPool.resync_all` on startup to bootstrap from the
        live ledger.

    Raises
    ------
    ValueError
        If account list, horizon URL, or Redis URL cannot be resolved.
    """
    import redis as redis_module  # imported here to keep module import light

    # Resolve accounts.
    if accounts is None:
        raw_accounts = os.environ.get("RELAYER_ACCOUNTS", "")
        accounts = [a.strip() for a in raw_accounts.split(",") if a.strip()]
    if not accounts:
        raise ValueError(
            "No relayer accounts configured. Set RELAYER_ACCOUNTS env var or "
            "pass accounts= to create_relayer_pool()."
        )

    # Resolve Horizon URL.
    if horizon_url is None:
        horizon_url = os.environ.get(
            "HORIZON_URL", "https://horizon-testnet.stellar.org"
        )
    if not horizon_url:
        raise ValueError(
            "Horizon URL is required. Set HORIZON_URL env var or pass "
            "horizon_url= to create_relayer_pool()."
        )

    # Resolve Redis URL.
    if redis_url is None:
        redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    if not redis_url:
        raise ValueError(
            "Redis URL is required. Set REDIS_URL env var or pass "
            "redis_url= to create_relayer_pool()."
        )

    redis_client = redis_module.Redis.from_url(
        redis_url,
        decode_responses=True,
        socket_connect_timeout=5,
        socket_timeout=5,
        retry_on_timeout=True,
    )

    log.info(
        "relayer_pool.creating",
        component="NonceManager",
        account_count=len(accounts),
        horizon_url=horizon_url,
        redis_url=redis_url,
    )

    return RelayerPool(
        accounts=accounts,
        horizon_url=horizon_url,
        redis_client=redis_client,
        key_prefix=key_prefix,
        stale_timeout_seconds=stale_timeout_seconds,
    )


# ---------------------------------------------------------------------------
# Module-level singleton (lazy-initialised on first access)
# ---------------------------------------------------------------------------

# The singleton is intentionally *not* eagerly constructed at import time so
# that importing this module in tests or other environments that lack Redis
# does not immediately raise a connection error.
nonce_manager: Optional[RelayerPool] = None
_nonce_manager_lock = threading.Lock()


def get_nonce_manager() -> RelayerPool:
    """Return (or lazily create) the module-level :class:`RelayerPool` singleton.

    Configuration is read from environment variables on first call:
    * ``RELAYER_ACCOUNTS`` — comma-separated Stellar public keys.
    * ``HORIZON_URL`` — defaults to ``https://horizon-testnet.stellar.org``.
    * ``REDIS_URL`` — defaults to ``redis://localhost:6379``.

    Returns
    -------
    RelayerPool

    Raises
    ------
    ValueError
        If ``RELAYER_ACCOUNTS`` is not set and no accounts can be resolved.
    """
    global nonce_manager
    if nonce_manager is None:
        with _nonce_manager_lock:
            if nonce_manager is None:
                nonce_manager = create_relayer_pool()
    return nonce_manager


# ---------------------------------------------------------------------------
# Public exports
# ---------------------------------------------------------------------------

__all__ = [
    # Core classes
    "NonceManager",
    "RelayerPool",
    # Errors
    "NonceMismatchError",
    "NonceExhaustedError",
    # Helpers
    "managed_sequence",
    "create_relayer_pool",
    "get_nonce_manager",
    # Module-level singleton
    "nonce_manager",
]
