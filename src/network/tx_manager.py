"""Transaction broadcast ordering for transport-layer workers.

The manager in this module keeps sequence assignment, payload signing, and
network dispatch inside the same per-source-account critical section. That
prevents parallel broadcast workers from signing valid sequential payloads and
then sending them to the Stellar network out of order.

Sequence numbers are tracked via NonceTracker (network.nonce_tracker), which
additionally records each issued sequence as "pending" until this manager
confirms or fails it based on the dispatcher's response. This allows stale
in-flight transactions -- e.g. ones whose broadcast dropped or whose response
was lost -- to be detected via NonceTracker.get_stale() instead of silently
assumed to have landed.
"""

from __future__ import annotations
import asyncio

import copy
import logging
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, MutableMapping, Optional, Protocol

from network.nonce_tracker import NonceTracker, nonce_tracker

logger = logging.getLogger(__name__)

Payload = MutableMapping[str, Any]
Signer = Callable[[Payload], Payload]
Dispatcher = Callable[[Payload], Any]

SuspiciousTxCallback = Callable[[str, Dict[str, Any]], None]

# NOTE: TxManager treats any dispatcher call that returns without raising as
# a success (confirm()), and any raised exception as a failure (fail()).
# It deliberately does not inspect dispatch_result's contents -- e.g. an
# HTTP status code -- since dispatcher's return shape is caller-defined and
# TxManager has no generic way to interpret it (see horizon_pool.py, whose
# broadcast_transaction() returns a urllib3 response with a `.status`, vs
# this module's own test suite, whose dispatchers return plain values).
# TODO: a horizon_pool-specific caller should inspect the returned response's
#       status itself and call tx_manager._tracker.fail()/confirm() (or a
#       future explicit override hook) based on real HTTP semantics --
#       including treating a 504 timeout as "unknown, needs polling" rather
#       than a hard failure, per Horizon's docs.
# TODO: parse `extras.result_codes.transaction` (e.g. "tx_bad_seq") on failure
#       responses and auto-call nonce_tracker.sync_nonce() when appropriate.


class TxPayloadSigner(Protocol):
    def __call__(self, payload: Payload) -> Payload:
        """Sign and return a transaction payload."""


class TxPayloadDispatcher(Protocol):
    def __call__(self, payload: Payload) -> Any:
        """Dispatch a signed transaction payload."""


class AtomicIntegerCounter:
    """Thread-safe integer counter with explicit bootstrap and sync support.

    Retained for backward compatibility (e.g. existing tests that exercise
    this class directly). TxManager itself no longer uses this internally --
    it delegates sequence tracking to NonceTracker (network.nonce_tracker),
    which adds pending/confirm/fail/stale bookkeeping on top of the same
    seed-then-increment contract implemented here.
    """

    def __init__(self) -> None:
        self._value: Optional[int] = None
        self._lock = threading.Lock()

    def next(self, seed: Optional[int] = None) -> int:
        """Return the next sequential integer atomically.

        The first call requires ``seed`` and returns that value. Later calls
        increment the cached value by one.
        """

        with self._lock:
            if self._value is None:
                if seed is None:
                    raise ValueError("Counter has not been seeded.")
                self._value = self._coerce_sequence(seed)
                return self._value

            self._value += 1
            return self._value

    def sync(self, value: int) -> None:
        """Replace the cached value with a known-good sequence."""

        with self._lock:
            self._value = self._coerce_sequence(value)

    def invalidate(self) -> None:
        """Clear the cached value so the next caller must provide a seed."""

        with self._lock:
            self._value = None

    @property
    def current(self) -> Optional[int]:
        with self._lock:
            return self._value

    @staticmethod
    def _coerce_sequence(value: int) -> int:
        sequence = int(value)
        if sequence < 0:
            raise ValueError("Sequence must be a non-negative integer.")
        return sequence


@dataclass
class BroadcastResult:
    """Result wrapper that exposes the assigned sequence for tracking."""

    account_id: str
    sequence: int
    payload: Payload
    dispatch_result: Any


@dataclass
class FlashLoanAnomaly:
    """Detected flash-loan anomaly within a single ledger window."""

    ledger: int
    tx_hashes: list[str]
    pool_addresses: list[str]
    count: int

    def to_alert_payload(self) -> Dict[str, Any]:
        return {
            "ledger": self.ledger,
            "count": self.count,
            "tx_hashes": list(self.tx_hashes),
            "pool_addresses": list(self.pool_addresses),
        }




class TxManager:
    """Serialize signing and dispatch by account using NonceTracker sequencing.

    NonceTracker's own internal lock only protects the act of incrementing
    its counter -- it is released as soon as get_next_nonce() returns. That
    is NOT sufficient on its own to guarantee wire order: a thread that gets
    sequence 5 could still sign/dispatch slower than a thread that gets
    sequence 6 immediately after, letting 6 reach the network first. This
    class therefore keeps its own per-account lock spanning the full
    assign -> sign -> dispatch critical section, exactly as the original
    AtomicIntegerCounter-based implementation did, while delegating the
    sequence bookkeeping itself to NonceTracker.
    """

    def __init__(
        self,
        sequence_field: str = "sequence",
        tracker: Optional[NonceTracker] = None,
    ) -> None:
        self.sequence_field = sequence_field
        # Defaults to a private, standalone NonceTracker -- NOT the shared
        # module-level singleton -- so that two independently-constructed
        # TxManager instances never silently share sequence state for the
        # same account_id. Pass tracker=nonce_tracker explicitly to opt in
        # to the shared, process-wide singleton (e.g. if multiple TxManager
# instances genuinely need to coordinate over the same accounts).
        self._tracker = tracker if tracker is not None else NonceTracker.create_standalone()
        self._account_locks: Dict[str, threading.Lock] = {}
        self._account_locks_map_lock = threading.Lock()
        self._flash_loan_lock = threading.Lock()
        self._flash_loan_window: Dict[int, list[Dict[str, Any]]] = {}
        self._flash_loan_threshold = 3

    def _get_account_lock(self, account_id: str) -> threading.Lock:
        lock = self._account_locks.get(account_id)
        if lock is None:
            with self._account_locks_map_lock:
                lock = self._account_locks.get(account_id)
                if lock is None:
                    lock = threading.Lock()
                    self._account_locks[account_id] = lock
        return lock

    def broadcast(
        self,
        account_id: str,
        payload: Payload,
        *,
        signer: Signer,
        dispatcher: Dispatcher,
        seed_sequence: Optional[int] = None,
    ) -> BroadcastResult:
        """Assign a sequence, sign the payload, and dispatch it in order.

        After dispatch, the outcome is reported back to the NonceTracker:
        a successful (2xx) result calls confirm(), anything else calls
        fail(). This keeps pending-slot bookkeeping accurate without
        changing the existing assign-sign-dispatch locking behavior.

        Args:
            account_id: Source account whose transaction sequence is tracked.
            payload: Transaction payload. It is deep-copied before mutation.
            signer: Callable that signs the sequenced payload and returns it.
            dispatcher: Callable that sends the signed payload to the network.
            seed_sequence: Required on first use for an account.

        Returns:
            BroadcastResult containing the assigned sequence, signed payload,
            and dispatcher response.
        """

        if not account_id:
            raise ValueError("account_id is required.")

        lock = self._get_account_lock(account_id)
        with lock:
            # Holding this lock across assign -> sign -> dispatch is what
            # prevents a later sequence from leapfrogging an earlier one on the
            # wire if signing happens to take longer for one worker.
            # NonceTracker's own lock is not sufficient for this -- it only
            # protects the increment itself, not this whole section.
            sequence = self._tracker.get_next_nonce(account_id, seed=seed_sequence)
            sequenced_payload = self._with_sequence(payload, sequence)
            signed_payload = signer(sequenced_payload)
            self._assert_signed_sequence(signed_payload, sequence)

            try:
                dispatch_result = dispatcher(signed_payload)
            except Exception:
                # The dispatcher raised (e.g. urllib3 TimeoutError or
                # MaxRetryError) rather than returning a response at all.
                # This is the only failure signal TxManager can generically
                # detect, since dispatcher's return shape is caller-defined
                # (see module-level note: interpreting e.g. an HTTP status
                # code is the caller's responsibility, not TxManager's).
                self._tracker.fail(account_id, sequence)
                logger.error(
                    "[TxManager] Dispatch raised for %s at sequence %d",
                    account_id,
                    sequence,
                )
                raise

            # No exception means dispatch completed. TxManager does not
            # inspect dispatch_result's contents (e.g. an HTTP status code)
            # since its shape is caller-defined -- see module-level TODOs for
            # where a horizon_pool-specific caller could add finer-grained
            # success/failure/unknown handling (e.g. treating a 4xx/5xx
            # response, or a 504 timeout specifically, differently from a
            # clean 2xx) before/instead of relying on this confirm() call.
            self._tracker.confirm(account_id, sequence)

        logger.info(
            "[TxManager] Dispatched transaction for %s with sequence %d",
            account_id,
            sequence,
        )

        return BroadcastResult(
            account_id=account_id,
            sequence=sequence,
            payload=signed_payload,
            dispatch_result=dispatch_result,
        )

    def record_flash_loan_candidate(
        self,
        ledger: int,
        tx_hash: str,
        pool_address: str,
        *,
        on_anomaly: Optional[SuspiciousTxCallback] = None,
    ) -> Optional[FlashLoanAnomaly]:
        """Record a suspicious flash loan and detect per-ledger anomalies.

        When more than ``_flash_loan_threshold`` suspicious flash loans are
        observed within a single ledger window, an anomaly is returned and
        ``on_anomaly`` (if provided) is invoked synchronously so the caller
        can submit an emergency pause within the same ledger window.
        """

        with self._flash_loan_lock:
            bucket = self._flash_loan_window.setdefault(ledger, [])
            bucket.append({"tx_hash": tx_hash, "pool_address": pool_address})
            if len(bucket) <= self._flash_loan_threshold:
                return None
            anomaly = FlashLoanAnomaly(
                ledger=ledger,
                tx_hashes=[entry["tx_hash"] for entry in bucket],
                pool_addresses=[entry["pool_address"] for entry in bucket],
                count=len(bucket),
            )
            # Reset the window so subsequent flash loans in the same ledger
            # start a fresh count instead of re-triggering on every additional tx.
            self._flash_loan_window[ledger] = []

        if on_anomaly is not None:
            on_anomaly(tx_hash, anomaly.to_alert_payload())

        return anomaly

    def _with_sequence(self, payload: Payload, sequence: int) -> Payload:
        sequenced_payload = copy.deepcopy(payload)
        sequenced_payload[self.sequence_field] = sequence
        return sequenced_payload

    def _assert_signed_sequence(self, signed_payload: Payload, sequence: int) -> None:
        actual = signed_payload.get(self.sequence_field)
        if actual != sequence:
            raise ValueError(
                f"Signer altered sequence field '{self.sequence_field}': "
                f"expected {sequence}, got {actual}"
            )
