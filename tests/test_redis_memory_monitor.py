"""tests/test_redis_memory_monitor.py — Unit and integration tests for Redis memory monitoring

and automated volatile cache eviction (Issue #1315).
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from app.services.redis_memory_monitor import (
    RedisMemoryMonitor,
    _redact_url,
    reset_alert_cooldown,
    run_redis_memory_monitor,
)
from app.tasks import monitor_redis_memory_task


class _MockPipeline:
    """Minimal redis pipeline supporting only the PTTL batch used by the monitor."""

    def __init__(self, client: "MockRedis"):
        self._client = client
        self._keys: list[str] = []

    def pttl(self, key: str) -> "_MockPipeline":
        self._keys.append(key)
        return self

    def execute(self) -> list[int]:
        return [self._client.pttl(key) for key in self._keys]


class MockRedis:
    """In-memory mock for redis.Redis client supporting scan, unlink, delete, info, pttl."""

    def __init__(
        self,
        keys_dict: dict[str, str] | None = None,
        memory_info: dict[str, int] | None = None,
        ttls: dict[str, int] | None = None,
    ):
        self.store = dict(keys_dict or {})
        self.ttls = dict(ttls or {})
        self.memory_info = memory_info or {
            "used_memory": 850 * 1024 * 1024,
            "maxmemory": 1000 * 1024 * 1024,
            "total_system_memory": 2000 * 1024 * 1024,
        }
        self.unlink_calls: list[tuple] = []
        self.delete_calls: list[tuple] = []

    def info(self, section: str = "memory") -> dict[str, int]:
        return dict(self.memory_info)

    def pipeline(self, transaction: bool = True) -> _MockPipeline:
        return _MockPipeline(self)

    def pttl(self, key: str) -> int:
        # Keys are volatile by default; pass ttls={key: -1} for persistent ones.
        return self.ttls.get(key, 300_000)

    def scan(self, cursor: int = 0, match: str | None = None, count: int = 100) -> tuple[int, list[str]]:
        import fnmatch

        all_keys = list(self.store.keys())
        if match:
            matched = [k for k in all_keys if fnmatch.fnmatch(k, match)]
        else:
            matched = all_keys

        # Simple single-cursor pagination mock
        return 0, matched

    def unlink(self, *keys: str) -> int:
        self.unlink_calls.append(keys)
        count = 0
        for k in keys:
            if k in self.store:
                del self.store[k]
                count += 1
        return count

    def delete(self, *keys: str) -> int:
        self.delete_calls.append(keys)
        count = 0
        for k in keys:
            if k in self.store:
                del self.store[k]
                count += 1
        return count


class TestRedisMemoryStats:
    """Test memory calculation from INFO memory."""

    def test_memory_below_threshold(self):
        client = MockRedis(memory_info={"used_memory": 700 * 1024 * 1024, "maxmemory": 1000 * 1024 * 1024})
        monitor = RedisMemoryMonitor(redis_client=client, threshold_percent=85.0)

        stats = monitor.get_memory_stats()
        assert stats.utilization_percent == 70.0
        assert not stats.is_above_threshold
        assert "700.00 MB" in stats.used_memory_human

    def test_memory_above_threshold(self):
        client = MockRedis(memory_info={"used_memory": 900 * 1024 * 1024, "maxmemory": 1000 * 1024 * 1024})
        monitor = RedisMemoryMonitor(redis_client=client, threshold_percent=85.0)

        stats = monitor.get_memory_stats()
        assert stats.utilization_percent == 90.0
        assert stats.is_above_threshold

    def test_fallback_when_maxmemory_zero(self, monkeypatch):
        # maxmemory 0 means unbounded; check fallback to REDIS_MAX_MEMORY_BYTES
        monkeypatch.setenv("REDIS_MAX_MEMORY_BYTES", str(500 * 1024 * 1024))
        client = MockRedis(memory_info={"used_memory": 450 * 1024 * 1024, "maxmemory": 0})
        monitor = RedisMemoryMonitor(redis_client=client, threshold_percent=85.0)

        stats = monitor.get_memory_stats()
        assert stats.maxmemory_bytes == 500 * 1024 * 1024
        assert stats.utilization_percent == 90.0
        assert stats.is_above_threshold

    def test_unbounded_memory_is_not_above_threshold(self):
        client = MockRedis(memory_info={"used_memory": 900, "maxmemory": 0})
        monitor = RedisMemoryMonitor(redis_client=client, threshold_percent=85.0)

        stats = monitor.get_memory_stats()
        assert stats.maxmemory_bytes == 0
        assert stats.utilization_percent == 0.0
        assert not stats.is_above_threshold


class TestProtectedKeysPreservation:
    """Test safety rules to guarantee critical session and operational keys are never evicted."""

    def test_session_keys_protected(self):
        monitor = RedisMemoryMonitor(redis_client=MockRedis())

        assert monitor.is_protected_key("session:user_123")
        assert monitor.is_protected_key("session:active_tokens")
        assert monitor.is_protected_key("user_session:alice")
        assert monitor.is_protected_key("app:session:state")
        assert monitor.is_protected_key("AUTH:session_id")

    def test_critical_infrastructure_keys_protected(self):
        monitor = RedisMemoryMonitor(redis_client=MockRedis())

        assert monitor.is_protected_key("auth:jwt_blacklist")
        assert monitor.is_protected_key("nonce:relayer:GD123")
        assert monitor.is_protected_key("lock:rebalance:active")
        assert monitor.is_protected_key("relayer:balance_cache")
        assert monitor.is_protected_key("nullifier:tree:1")
        assert monitor.is_protected_key("webhook:retry_queue")
        assert monitor.is_protected_key("dlq:dead_letter")

    def test_real_stellarflow_keys_protected(self):
        monitor = RedisMemoryMonitor(redis_client=MockRedis())

        assert monitor.is_protected_key("stellarflow:auth:challenge")
        assert monitor.is_protected_key("stellarflow:auth:credential:abc")
        assert monitor.is_protected_key("stellarflow:nonce:GABC")
        assert monitor.is_protected_key("stellarflow:nullifier-tree:7")
        assert monitor.is_protected_key("stellarflow:webhook:retry:1")
        assert monitor.is_protected_key("stellarflow:dlq")
        assert monitor.is_protected_key("stellarflow:vault:lock:acct")
        assert monitor.is_protected_key("stellarflow:sessions:abc")
        assert monitor.is_protected_key("stellarflow:ledger-events")
        assert monitor.is_protected_key("stellarflow:zk:merkle-root:1")
        assert monitor.is_protected_key("stellarflow:lockdown:v1")

    def test_glob_protection_patterns_are_honoured(self):
        monitor = RedisMemoryMonitor(redis_client=MockRedis(), protected_patterns=["*nonce*"])

        assert monitor.is_protected_key("cache:analytics:nonce:1")
        assert not monitor.is_protected_key("cache:analytics:price:1")

    def test_volatile_analytics_keys_not_protected(self):
        monitor = RedisMemoryMonitor(redis_client=MockRedis())

        assert not monitor.is_protected_key("analytics:hourly:price")
        assert not monitor.is_protected_key("cache:analytics:heatmap")
        assert not monitor.is_protected_key("volatile:temporary_order_buffer")
        assert not monitor.is_protected_key("stellarflow:zk:proof:0xabcdef")
        assert not monitor.is_protected_key("stellarflow:cache:endpoint:abc")

    def test_unrestricted_namespace_is_ignored(self):
        monitor = RedisMemoryMonitor(
            redis_client=MockRedis(),
            volatile_namespaces=["*", "  ", "analytics:*"],
        )
        assert monitor.volatile_namespaces == ["analytics:*"]


class TestEvictionExecution:
    """Test targeted eviction process and behavior."""

    def test_no_eviction_when_memory_healthy(self):
        client = MockRedis(
            keys_dict={
                "analytics:1": "val1",
                "analytics:2": "val2",
                "session:user1": "sess",
            },
            memory_info={"used_memory": 500 * 1024 * 1024, "maxmemory": 1000 * 1024 * 1024},
        )
        monitor = RedisMemoryMonitor(redis_client=client, threshold_percent=85.0)

        report = monitor.evict_volatile_keys()
        assert report.evicted_keys_count == 0
        assert "analytics:1" in client.store
        assert "session:user1" in client.store

    def test_targeted_eviction_removes_analytics_and_preserves_session(self):
        keys = {
            "analytics:candle:1m": "data1",
            "analytics:candle:5m": "data2",
            "cache:analytics:ohlc": "data3",
            "volatile:temp_rates": "data4",
            "session:token_active": "CRITICAL_SESSION",
            "auth:bearer_token": "CRITICAL_AUTH",
            "nonce:relayer:address": "CRITICAL_NONCE",
        }
        client = MockRedis(
            keys_dict=keys,
            memory_info={"used_memory": 920 * 1024 * 1024, "maxmemory": 1000 * 1024 * 1024},
        )
        monitor = RedisMemoryMonitor(redis_client=client, threshold_percent=85.0, alert_webhook_urls=[])

        report = monitor.evict_volatile_keys()

        # Volatile keys must be evicted
        assert "analytics:candle:1m" not in client.store
        assert "analytics:candle:5m" not in client.store
        assert "cache:analytics:ohlc" not in client.store
        assert "volatile:temp_rates" not in client.store

        # Critical keys must remain intact
        assert client.store.get("session:token_active") == "CRITICAL_SESSION"
        assert client.store.get("auth:bearer_token") == "CRITICAL_AUTH"
        assert client.store.get("nonce:relayer:address") == "CRITICAL_NONCE"

        assert report.evicted_keys_count == 4

    def test_persistent_keys_are_never_evicted(self):
        keys = {
            "stellarflow:zk:proof:aa": "cached",
            "stellarflow:cache:endpoint:bb": "cached",
            "stellarflow:cache:persistent": "must-survive",
        }
        client = MockRedis(
            keys_dict=keys,
            ttls={"stellarflow:cache:persistent": -1},
            memory_info={"used_memory": 950 * 1024 * 1024, "maxmemory": 1000 * 1024 * 1024},
        )
        monitor = RedisMemoryMonitor(redis_client=client, threshold_percent=85.0, alert_webhook_urls=[])

        report = monitor.evict_volatile_keys()

        assert "stellarflow:zk:proof:aa" not in client.store
        assert "stellarflow:cache:endpoint:bb" not in client.store
        assert "stellarflow:cache:persistent" in client.store
        assert report.evicted_keys_count == 2

    def test_max_eviction_cap_respected(self):
        keys = {f"analytics:key_{i}": f"v_{i}" for i in range(50)}
        client = MockRedis(
            keys_dict=keys,
            memory_info={"used_memory": 950 * 1024 * 1024, "maxmemory": 1000 * 1024 * 1024},
        )
        monitor = RedisMemoryMonitor(redis_client=client, threshold_percent=85.0, alert_webhook_urls=[])

        report = monitor.evict_volatile_keys(max_evictions=10)
        assert report.evicted_keys_count == 10
        assert report.stopped_early


class TestThresholdConfiguration:
    """Test the 1..100 clamp and environment precedence."""

    @pytest.mark.parametrize(
        "env_val, expected",
        [
            ("0", 1.0),
            ("-20", 1.0),
            ("150", 100.0),
            ("42", 42.0),
        ],
    )
    def test_threshold_is_clamped(self, monkeypatch, env_val, expected):
        monkeypatch.setenv("REDIS_MEMORY_THRESHOLD_PERCENT", env_val)
        monitor = RedisMemoryMonitor(redis_client=MockRedis(), threshold_percent=85.0)
        assert monitor.threshold_percent == expected

    def test_invalid_threshold_falls_back(self, monkeypatch):
        monkeypatch.setenv("REDIS_MEMORY_THRESHOLD_PERCENT", "eighty-five")
        monitor = RedisMemoryMonitor(redis_client=MockRedis(), threshold_percent=85.0)
        assert monitor.threshold_percent == 85.0


class TestDevopsAlerts:
    """Test DevOps notification webhooks and rate limiting."""

    def test_alert_payload_and_delivery(self):
        reset_alert_cooldown()
        client = MockRedis(
            keys_dict={"analytics:temp": "v"},
            memory_info={"used_memory": 900 * 1024 * 1024, "maxmemory": 1000 * 1024 * 1024},
        )
        monitor = RedisMemoryMonitor(
            redis_client=client,
            threshold_percent=85.0,
            alert_webhook_urls=["https://devops.internal/webhook"],
            alert_cooldown_seconds=60.0,
        )

        with patch.object(monitor, "_post_webhook", return_value=True) as mock_post:
            report = monitor.evict_volatile_keys()
            assert report.alert_sent
            assert mock_post.called
            url, payload = mock_post.call_args[0]
            assert url == "https://devops.internal/webhook"
            assert payload["alert_type"] == "redis_memory_pressure"
            assert payload["metrics"]["threshold_percent"] == 85.0
            assert payload["metrics"]["evicted_keys"] == 1
            assert report.alert_details == {
                "delivered": True,
                "targets": [_redact_url("https://devops.internal/webhook")],
            }

    def test_alert_cooldown_suppression(self):
        reset_alert_cooldown()
        client = MockRedis(
            keys_dict={"analytics:temp": "v"},
            memory_info={"used_memory": 900 * 1024 * 1024, "maxmemory": 1000 * 1024 * 1024},
        )
        monitor = RedisMemoryMonitor(
            redis_client=client,
            threshold_percent=85.0,
            alert_webhook_urls=["https://devops.internal/webhook"],
            alert_cooldown_seconds=300.0,
        )

        with patch.object(monitor, "_post_webhook", return_value=True) as mock_post:
            # First alert sent
            r1 = monitor.evict_volatile_keys()
            assert mock_post.call_count == 1
            assert r1.alert_sent

            # Second immediate run should be suppressed by cooldown
            r2 = monitor.evict_volatile_keys()
            assert mock_post.call_count == 1
            assert not r2.alert_sent

    def test_webhook_urls_are_redacted_in_logs(self):
        redacted = _redact_url("https://hooks.slack.com/services/T000/B000/super-secret-token")
        assert redacted.startswith("https://hooks.slack.com/")
        assert "super-secret-token" not in redacted
        assert redacted.endswith("oken")


class TestCeleryTaskExecution:
    """Test top-level Celery task and helper integration."""

    def test_run_redis_memory_monitor_helper(self):
        client = MockRedis(
            keys_dict={"analytics:k1": "v1"},
            memory_info={"used_memory": 900 * 1024 * 1024, "maxmemory": 1000 * 1024 * 1024},
        )
        result = run_redis_memory_monitor(redis_client=client, threshold_percent=85.0)

        assert result["status"] == "success"
        assert result["threshold_percent"] == 85.0
        assert result["evicted_keys"] == 1

    def test_monitor_redis_memory_task_success(self):
        with patch(
            "app.services.redis_memory_monitor.run_redis_memory_monitor",
            return_value={"status": "success", "evicted_keys": 5},
        ):
            res = monitor_redis_memory_task.apply(kwargs={"threshold_percent": 85.0}).get()
            assert res["status"] == "success"
            assert res["evicted_keys"] == 5

    def test_monitor_redis_memory_task_propagates_errors(self):
        with patch(
            "app.services.redis_memory_monitor.run_redis_memory_monitor",
            side_effect=RuntimeError("Redis connection refused"),
        ):
            with pytest.raises(RuntimeError, match="Redis connection refused"):
                monitor_redis_memory_task.apply().get()
