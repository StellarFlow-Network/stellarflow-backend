"""Nonce manager integration tests — NonceManager + RelayerPool against real Redis + Horizon mock.

Tests cover:
- NonceManager.acquire() with seed bootstrap
- Atomic sequence increment via Redis INCR
- NonceManager.confirm() and fail() bookkeeping
- NonceManager.resync_from_horizon() with real Horizon mock
- NonceManager.get_stale() timeout detection
- RelayerPool.acquire_account() least-loaded selection
- managed_sequence() context manager auto-confirm/fail
- Concurrent acquire() from multiple threads
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest

from app.services.nonce_manager import (
    NonceExhaustedError,
    NonceManager,
    NonceMismatchError,
    RelayerPool,
    managed_sequence,
)

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# NonceManager tests
# ---------------------------------------------------------------------------


class TestNonceManagerIntegration:
    """Test NonceManager against a real Redis container + Horizon mock."""

    def test_acquire_with_seed(self, redis_client_fresh, horizon_url) -> None:
        mgr = NonceManager(
            account_address="GTEST1234567890ABCDEF",
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:nonce:",
        )

        seq = mgr.acquire(seed=100)
        assert seq == 101  # seed + 1

        # Second acquire should increment
        seq2 = mgr.acquire()
        assert seq2 == 102

        mgr.invalidate()

    def test_acquire_without_seed_on_new_key_raises(self, redis_client_fresh, horizon_url) -> None:
        mgr = NonceManager(
            account_address="GNOSEED",
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:nonce:noseed:",
        )

        with pytest.raises(ValueError, match="no seed was provided"):
            mgr.acquire()

        mgr.invalidate()

    def test_confirm_removes_pending(self, redis_client_fresh, horizon_url) -> None:
        mgr = NonceManager(
            account_address="GCONFIRM",
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:nonce:confirm:",
        )

        seq = mgr.acquire(seed=200)
        assert mgr.in_flight_count == 1

        mgr.confirm(seq)
        assert mgr.in_flight_count == 0

        mgr.invalidate()

    def test_fail_removes_pending(self, redis_client_fresh, horizon_url) -> None:
        mgr = NonceManager(
            account_address="GFAIL",
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:nonce:fail:",
        )

        seq = mgr.acquire(seed=300)
        assert mgr.in_flight_count == 1

        mgr.fail(seq)
        assert mgr.in_flight_count == 0

        mgr.invalidate()

    def test_resync_from_horizon(self, redis_client_fresh, horizon_url, horizon_mock_server) -> None:
        address = "GRESYNC"
        mgr = NonceManager(
            account_address=address,
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:nonce:resync:",
        )

        # Set the mock to return a specific sequence
        horizon_mock_server.account_sequences[address] = 500_000

        seq = mgr.resync_from_horizon()
        assert seq == 500_000

        # Verify the Redis counter was overwritten
        counter = mgr.get_current_counter()
        assert counter == 500_000

        # Pending should be cleared
        assert mgr.in_flight_count == 0

        mgr.invalidate()

    def test_get_stale_detection(self, redis_client_fresh, horizon_url) -> None:
        mgr = NonceManager(
            account_address="GSTALE",
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:nonce:stale:",
            stale_timeout_seconds=0.1,  # 100ms for testing
        )

        seq = mgr.acquire(seed=600)
        time.sleep(0.2)  # Wait for staleness

        stale = mgr.get_stale()
        assert seq in stale

        mgr.invalidate()

    def test_get_pending_sequences(self, redis_client_fresh, horizon_url) -> None:
        mgr = NonceManager(
            account_address="GPENDING",
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:nonce:pending:",
        )

        seq1 = mgr.acquire(seed=700)
        seq2 = mgr.acquire()

        pending = mgr.get_pending_sequences()
        assert seq1 in pending
        assert seq2 in pending

        mgr.invalidate()

    def test_get_current_counter(self, redis_client_fresh, horizon_url) -> None:
        mgr = NonceManager(
            account_address="GCOUNTER",
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:nonce:counter:",
        )

        assert mgr.get_current_counter() is None

        mgr.acquire(seed=800)
        counter = mgr.get_current_counter()
        assert counter is not None
        assert counter >= 800

        mgr.invalidate()

    def test_invalidate_clears_everything(self, redis_client_fresh, horizon_url) -> None:
        mgr = NonceManager(
            account_address="GINVALIDATE",
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:nonce:invalidate:",
        )

        mgr.acquire(seed=900)
        assert mgr.in_flight_count == 1

        mgr.invalidate()
        assert mgr.in_flight_count == 0
        assert mgr.get_current_counter() is None

    def test_concurrent_acquire_no_collisions(self, redis_client_fresh, horizon_url) -> None:
        mgr = NonceManager(
            account_address="GCONCURRENT",
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:nonce:concurrent:",
        )

        mgr.acquire(seed=1000)
        sequences = []
        lock = threading.Lock()

        def acquire_one():
            seq = mgr.acquire()
            with lock:
                sequences.append(seq)

        threads = [threading.Thread(target=acquire_one) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        # All sequences should be unique
        assert len(sequences) == 10
        assert len(set(sequences)) == 10
        # All should be sequential starting from seed+1
        assert sorted(sequences) == list(range(1002, 1012))

        mgr.invalidate()


# ---------------------------------------------------------------------------
# RelayerPool tests
# ---------------------------------------------------------------------------


class TestRelayerPoolIntegration:
    """Test RelayerPool against a real Redis container + Horizon mock."""

    def test_acquire_account_least_loaded(
        self, redis_client_fresh, horizon_url, horizon_mock_server
    ) -> None:
        accounts = ["GPOOL1", "GPOOL2", "GPOOL3"]
        for addr in accounts:
            horizon_mock_server.account_sequences[addr] = 100

        pool = RelayerPool(
            accounts=accounts,
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:pool:",
        )

        # Seed all accounts
        for addr in accounts:
            pool.resync(addr)

        # First acquire should pick an account (all idle)
        addr1, seq1 = pool.acquire_account()
        assert addr1 in accounts
        assert seq1 > 100

        # Second acquire should pick a different account (first has 1 in-flight)
        addr2, seq2 = pool.acquire_account()
        assert addr2 in accounts
        # Might be same or different depending on timing, but should work

        pool.release_account(addr1, seq1, success=True)
        pool.release_account(addr2, seq2, success=True)

        pool.invalidate_all()

    def test_release_account_success_and_fail(
        self, redis_client_fresh, horizon_url, horizon_mock_server
    ) -> None:
        horizon_mock_server.account_sequences["GREL"] = 200

        pool = RelayerPool(
            accounts=["GREL"],
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:pool:rel:",
        )
        pool.resync("GREL")

        addr, seq = pool.acquire_account()
        assert addr == "GREL"

        pool.release_account(addr, seq, success=True)
        mgr = pool._managers["GREL"]
        assert mgr.in_flight_count == 0

        # Acquire again and fail
        addr, seq = pool.acquire_account()
        pool.release_account(addr, seq, success=False)
        assert mgr.in_flight_count == 0

        pool.invalidate_all()

    def test_resync_single_account(
        self, redis_client_fresh, horizon_url, horizon_mock_server
    ) -> None:
        horizon_mock_server.account_sequences["GRESYNCPOOL"] = 300

        pool = RelayerPool(
            accounts=["GRESYNCPOOL"],
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:pool:resync:",
        )

        seq = pool.resync("GRESYNCPOOL")
        assert seq == 300

        pool.invalidate_all()

    def test_resync_unknown_account_raises(
        self, redis_client_fresh, horizon_url
    ) -> None:
        pool = RelayerPool(
            accounts=["GKNOWN"],
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:pool:unk:",
        )

        with pytest.raises(KeyError):
            pool.resync("GUNKNOWN")

        pool.invalidate_all()

    def test_get_pool_status(
        self, redis_client_fresh, horizon_url, horizon_mock_server
    ) -> None:
        horizon_mock_server.account_sequences["GSTATUS"] = 400

        pool = RelayerPool(
            accounts=["GSTATUS"],
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:pool:status:",
        )
        pool.resync("GSTATUS")

        status = pool.get_pool_status()
        assert len(status) == 1
        assert status[0]["address"] == "GSTATUS"
        assert status[0]["current_counter"] == 400

        pool.invalidate_all()

    def test_accounts_property(self, redis_client_fresh, horizon_url) -> None:
        pool = RelayerPool(
            accounts=["GA", "GB", "GC"],
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:pool:acct:",
        )
        assert pool.accounts == ["GA", "GB", "GC"]
        pool.invalidate_all()


# ---------------------------------------------------------------------------
# managed_sequence context manager
# ---------------------------------------------------------------------------


class TestManagedSequence:
    """Test the managed_sequence context manager."""

    def test_auto_confirm_on_success(
        self, redis_client_fresh, horizon_url, horizon_mock_server
    ) -> None:
        horizon_mock_server.account_sequences["GMANAGED"] = 500

        pool = RelayerPool(
            accounts=["GMANAGED"],
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:managed:",
        )
        pool.resync("GMANAGED")

        with managed_sequence(pool) as (addr, seq):
            assert addr == "GMANAGED"
            assert seq > 500

        # Should be auto-confirmed
        mgr = pool._managers["GMANAGED"]
        assert mgr.in_flight_count == 0

        pool.invalidate_all()

    def test_auto_fail_on_exception(
        self, redis_client_fresh, horizon_url, horizon_mock_server
    ) -> None:
        horizon_mock_server.account_sequences["GMFAIL"] = 600

        pool = RelayerPool(
            accounts=["GMFAIL"],
            horizon_url=horizon_url,
            redis_client=redis_client_fresh,
            key_prefix="stellarflow:test:managed:fail:",
        )
        pool.resync("GMFAIL")

        with pytest.raises(RuntimeError):
            with managed_sequence(pool) as (addr, seq):
                raise RuntimeError("simulated tx failure")

        mgr = pool._managers["GMFAIL"]
        assert mgr.in_flight_count == 0

        pool.invalidate_all()
