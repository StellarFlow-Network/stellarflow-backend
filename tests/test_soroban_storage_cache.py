"""tests/test_soroban_storage_cache.py — Tests for Soroban contract instance storage memory-mapped cache.

Verifies:
1. LMDB memory-mapped key-value store for state caching.
2. Average key read times under 100µs.
3. Asynchronous synchronization with incoming Soroban ledger commit streams.
"""

from __future__ import annotations

import asyncio
import tempfile
import time
from pathlib import Path
import pytest

from src.cache.soroban_storage_cache import (
    LatencyBenchmarkResult,
    SorobanInstanceStorageCache,
    SorobanLedgerStreamSync,
    StorageEntry,
)


@pytest.fixture
def cache_dir(tmp_path):
    d = tmp_path / "soroban_mmap_db"
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture
def cache(cache_dir):
    c = SorobanInstanceStorageCache(db_path=cache_dir)
    yield c
    c.destroy()


class TestLMDBMemoryMappedStorage:
    """Test Criterion 1: Utilize RocksDB or LMDB memory-mapped key-value store for state caching."""

    def test_put_and_get_basic(self, cache):
        """Store and retrieve basic instance storage entry."""
        contract_id = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
        cache.put(contract_id, "admin", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")

        val = cache.get(contract_id, "admin")
        assert val == "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

    def test_put_structured_data(self, cache):
        """Store and retrieve complex structured data (reserves, config, pools)."""
        contract_id = "CCPOOL_LIQUIDITY_001"
        pool_state = {
            "token_a": "CAS3J7GYLGXMF6TDJBBYYSE3VUMTR45PV5WD4R5DYQIVZISDD2M3SQ5D",
            "token_b": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
            "reserve_a": 1500000000000,
            "reserve_b": 3000000000000,
            "total_shares": 2121320343559,
            "fee_bps": 30,
        }
        cache.put(contract_id, "pool_reserves", pool_state, ledger_sequence=123456)

        entry = cache.get_entry(contract_id, "pool_reserves")
        assert entry is not None
        assert entry.contract_id == contract_id
        assert entry.key == "pool_reserves"
        assert entry.value == pool_state
        assert entry.durability == "INSTANCE"
        assert entry.ledger_sequence == 123456

    def test_delete_and_has(self, cache):
        """Verify key existence check and deletion."""
        contract_id = "CTEST_CONTRACT"
        cache.put(contract_id, "nonce", 42)
        assert cache.has(contract_id, "nonce") is True

        deleted = cache.delete(contract_id, "nonce")
        assert deleted is True
        assert cache.has(contract_id, "nonce") is False
        assert cache.get(contract_id, "nonce") is None

    def test_batch_put_atomic(self, cache):
        """Batch insert updates multiple entries atomically."""
        contract_id = "CVAULT_CONTRACT_002"
        entries = [
            {"contract_id": contract_id, "key": "collateral_ratio", "value": 150},
            {"contract_id": contract_id, "key": "min_deposit", "value": 1000},
            {"contract_id": contract_id, "key": "is_paused", "value": False},
        ]
        count = cache.batch_put(entries, ledger_sequence=5000)
        assert count == 3

        all_entries = cache.get_contract_entries(contract_id)
        assert all_entries["collateral_ratio"] == 150
        assert all_entries["min_deposit"] == 1000
        assert all_entries["is_paused"] is False

    def test_persistence_across_reopen(self, cache_dir):
        """Data written to memory-mapped files persists when reopening the database."""
        contract_id = "CPERSIST_CONTRACT"
        with SorobanInstanceStorageCache(db_path=cache_dir) as c1:
            c1.put(contract_id, "config_hash", "0xdeadbeef12345678")
            c1.set_last_synced_ledger(9999)

        # Reopen from disk
        with SorobanInstanceStorageCache(db_path=cache_dir) as c2:
            val = c2.get(contract_id, "config_hash")
            assert val == "0xdeadbeef12345678"
            assert c2.get_last_synced_ledger() == 9999


class TestReadLatencyCriterion:
    """Test Criterion 2: Achieve average key read times under 100µs."""

    def test_average_key_read_time_under_100_microseconds(self, cache):
        """Benchmark confirms key reads from memory-mapped store take < 100 microseconds."""
        benchmark: LatencyBenchmarkResult = cache.benchmark_read_latency(num_reads=1000)

        assert benchmark.target_met is True
        assert benchmark.avg_latency_us < 100.0, (
            f"Expected avg read latency < 100µs, got {benchmark.avg_latency_us}µs"
        )
        assert benchmark.total_reads == 1000
        # Print latency for visibility in test logs
        print(
            f"\n[LMDB MMAP Benchmark] Avg: {benchmark.avg_latency_us}us | "
            f"p50: {benchmark.p50_latency_us}us | "
            f"p95: {benchmark.p95_latency_us}us | "
            f"p99: {benchmark.p99_latency_us}us | Target Met: {benchmark.target_met}"
        )

    def test_individual_timed_read(self, cache):
        """get_with_timing returns accurate microsecond latency."""
        contract_id = "CTIMED_CONTRACT"
        cache.put(contract_id, "cached_key", "sample_val")

        val, elapsed_us = cache.get_with_timing(contract_id, "cached_key")
        assert val == "sample_val"
        assert elapsed_us < 100.0


class TestAsyncLedgerCommitSynchronization:
    """Test Criterion 3: Synchronize local cache with incoming Soroban ledger commit streams asynchronously."""

    @pytest.mark.asyncio
    async def test_sync_ledger_commit_creates_and_updates(self, cache):
        """Synchronizer applies ledger commit state updates into cache."""
        sync = SorobanLedgerStreamSync(cache)
        contract_id = "CDEX_POOL_XLM_USDC"

        changes = [
            {
                "contract_id": contract_id,
                "key": "reserves",
                "value": {"xlm": 500000, "usdc": 60000},
                "durability": "INSTANCE",
                "type": "created",
            },
            {
                "contract_id": contract_id,
                "key": "fee_recipient",
                "value": "GA...TREASURY",
                "durability": "INSTANCE",
                "type": "created",
            },
            # Non-INSTANCE entry (e.g. TEMPORARY nonce) must be ignored
            {
                "contract_id": contract_id,
                "key": "temp_nonce",
                "value": 1,
                "durability": "TEMPORARY",
                "type": "created",
            },
        ]

        updated = await sync.sync_ledger_commit(ledger_sequence=1001, changes=changes)
        assert updated == 2

        # Verify cached state
        assert cache.get(contract_id, "reserves") == {"xlm": 500000, "usdc": 60000}
        assert cache.get(contract_id, "fee_recipient") == "GA...TREASURY"
        assert cache.get(contract_id, "temp_nonce") is None  # TEMPORARY was ignored
        assert cache.get_last_synced_ledger() == 1001

    @pytest.mark.asyncio
    async def test_sync_ledger_commit_handles_deletions(self, cache):
        """Synchronizer processes deletions from commit streams."""
        sync = SorobanLedgerStreamSync(cache)
        contract_id = "CGOV_PROPOSAL"
        cache.put(contract_id, "active_proposal_9", {"title": "Upgrade contract"})

        assert cache.has(contract_id, "active_proposal_9") is True

        changes = [
            {
                "contract_id": contract_id,
                "key": "active_proposal_9",
                "durability": "INSTANCE",
                "type": "deleted",
            }
        ]

        await sync.sync_ledger_commit(ledger_sequence=1002, changes=changes)
        assert cache.has(contract_id, "active_proposal_9") is False

    @pytest.mark.asyncio
    async def test_process_stream_message_rpc_format(self, cache):
        """Processes Soroban RPC JSON-RPC ledger commit notification."""
        sync = SorobanLedgerStreamSync(cache)
        contract_id = "CORACLE_CONTRACT"

        raw_rpc_event = {
            "jsonrpc": "2.0",
            "method": "notifyLedgerClose",
            "result": {
                "ledger": 54321,
                "contract_changes": [
                    {
                        "contract_id": contract_id,
                        "key": "latest_twap",
                        "value": 0.1254,
                        "durability": "INSTANCE",
                        "type": "updated",
                    }
                ],
            },
        }

        success = await sync.process_stream_message(raw_rpc_event)
        assert success is True
        assert cache.get(contract_id, "latest_twap") == 0.1254
        assert cache.get_last_synced_ledger() == 54321

    @pytest.mark.asyncio
    async def test_async_queue_consumer_background_sync(self, cache):
        """Asynchronous background worker synchronizes queued commits without blocking."""
        sync = SorobanLedgerStreamSync(cache)
        await sync.start()

        contract_id = "CSTREAM_CONTRACT"

        # Queue 10 ledger commits rapidly
        for seq in range(1, 11):
            msg = {
                "ledger_sequence": 2000 + seq,
                "changes": [
                    {
                        "contract_id": contract_id,
                        "key": "round",
                        "value": seq * 10,
                        "durability": "INSTANCE",
                    }
                ],
            }
            sync.queue_commit(msg)

        # Wait briefly for background consumer to process queue
        await asyncio.sleep(0.3)
        await sync.stop()

        # Cache is synchronized to the latest committed ledger
        assert cache.get(contract_id, "round") == 100
        assert cache.get_last_synced_ledger() == 2010

    @pytest.mark.asyncio
    async def test_concurrent_read_during_sync(self, cache):
        """Reads continue with sub-100µs latency while synchronization writes in background."""
        sync = SorobanLedgerStreamSync(cache)
        contract_id = "CCONCURRENT_CONTRACT"
        cache.put(contract_id, "live_price", 100.0)

        # Worker continuously updates the cache in background
        async def writer():
            for i in range(50):
                await sync.sync_ledger_commit(
                    ledger_sequence=3000 + i,
                    changes=[
                        {
                            "contract_id": contract_id,
                            "key": "live_price",
                            "value": 100.0 + i,
                            "durability": "INSTANCE",
                        }
                    ],
                )
                await asyncio.sleep(0.001)

        # Reader concurrently measures read latency
        read_latencies: list[float] = []

        async def reader():
            for _ in range(200):
                val, elapsed_us = cache.get_with_timing(contract_id, "live_price")
                assert val is not None
                read_latencies.append(elapsed_us)
                await asyncio.sleep(0.0005)

        await asyncio.gather(writer(), reader())

        avg_latency = sum(read_latencies) / len(read_latencies)
        assert avg_latency < 100.0, f"Concurrent avg latency was {avg_latency}us (expected <100us)"
        print(f"\n[Concurrent Read Latency under Write Load] Avg: {avg_latency:.2f}us")
