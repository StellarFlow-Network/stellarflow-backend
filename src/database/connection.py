#!/usr/bin/env python3
"""
Database Connection Keep-Alive, Adaptive Timeout Controller and Connection Profiler
=============================================================================
"""

import asyncio
import logging
import threading
import time
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple, Type
from collections import deque

try:
    import psycopg2
except ImportError:
    psycopg2 = None

logger = logging.getLogger(__name__)

DEFAULT_PING_INTERVAL: float = 30.0
HEARTBEAT_QUERY: str = "SELECT 1;"
DEFAULT_HEALTH_CHECK_INTERVAL: float = 15.0
DEFAULT_FAILURE_THRESHOLD: int = 2
DEFAULT_BASE_TIMEOUT_S: float = 5.0
DEFAULT_LATENCY_COEFFICIENT: float = 0.005
DEFAULT_CONNECTION_COEFFICIENT: float = 0.05
DEFAULT_MIN_TIMEOUT_S: float = 2.0
DEFAULT_MAX_TIMEOUT_S: float = 60.0
DEFAULT_LATENCY_WINDOW: int = 100
DEFAULT_INDEX_USAGE_THRESHOLD: float = 0.05
DEFAULT_MIN_INDEX_SCANS: int = 100
DEFAULT_ALERT_INTERVAL_S: float = 3600.0


class ConnectionPoolProfiler:
    """Profiler for monitoring PostgreSQL connection pools across request workers."""

    def __init__(
        self,
        max_pool_size: int = 10,
        slow_query_threshold_ms: float = 1000.0,
        recycle_limit_queries: int = 1000,
        recycle_max_age_s: float = 3600.0,
    ):
        self._max_pool_size = max_pool_size
        self._slow_query_threshold_ms = slow_query_threshold_ms
        self._recycle_limit_queries = recycle_limit_queries
        self._recycle_max_age_s = recycle_max_age_s
        self._active_connections = 0
        self._lock = threading.Lock()
        self._query_counts: Dict[str, int] = {}
        self._connection_ages: Dict[str, float] = {}

    def log_acquisition(self, duration_ms: float, pool_name: str = "default") -> None:
        logger.info("[%s] Connection acquired in %.2fms", pool_name, duration_ms)

    def update_pool_utilization(self, active: int) -> float:
        with self._lock:
            self._active_connections = active
            utilization = (active / self._max_pool_size) * 100.0 if self._max_pool_size > 0 else 0.0
        logger.debug("Active pool utilization: %.2f%% (%d/%d)", utilization, active, self._max_pool_size)
        return utilization

    def monitor_query(self, query_id: str, duration_ms: float) -> None:
        if duration_ms > self._slow_query_threshold_ms:
            logger.warning(
                "[ALERT] Query '%s' kept connection open for %.2fms (exceeds threshold of %.2fms)",
                query_id,
                duration_ms,
                self._slow_query_threshold_ms,
            )

    def should_recycle(self, connection_id: str, query_count: int, created_at: float) -> bool:
        age = time.time() - created_at
        if query_count >= self._recycle_limit_queries or age >= self._recycle_max_age_s:
            logger.info(
                "Recycling connection '%s': query_count=%d (limit=%d), age=%.2fs (limit=%.2fs)",
                connection_id,
                query_count,
                self._recycle_limit_queries,
                age,
                self._recycle_max_age_s,
            )
            return True
        return False


class IndexUsageTelemetry:
    def __init__(
        self,
        connection: Any,
        usage_threshold: float = DEFAULT_INDEX_USAGE_THRESHOLD,
        min_scans: int = DEFAULT_MIN_INDEX_SCANS,
        alert_interval: float = DEFAULT_ALERT_INTERVAL_S,
    ):
        if connection is None:
            raise ValueError("connection must not be None")
        if not (0.0 <= usage_threshold <= 1.0):
            raise ValueError("usage_threshold must be between 0.0 and 1.0")
        if min_scans < 0:
            raise ValueError("min_scans must be non-negative")
        if alert_interval <= 0:
            raise ValueError("alert_interval must be positive")

        self._connection = connection
        self._usage_threshold = usage_threshold
        self._min_scans = min_scans
        self._alert_interval = alert_interval
        self._index_stats: Dict[str, Dict[str, Any]] = {}

    def record_index_usage(self) -> None:
        if psycopg2 is None:
            return
        try:
            cursor = self._connection.cursor()
            cursor.execute(
                "SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch FROM pg_stat_user_indexes"
            )
            rows = cursor.fetchall()
            for row in rows:
                key = f"{row[0]}.{row[1]}.{row[2]}"
                self._index_stats[key] = {
                    "schemaname": row[0],
                    "table_name": row[1],
                    "index_name": row[2],
                    "index_scans": row[3],
                    "tuples_read": row[4],
                    "tuples_fetched": row[5],
                    "last_updated": time.time(),
                }
        except Exception as exc:
            logger.error("Failed to record index usage: %s", exc)

    def get_underutilized_alerts(self) -> List[Dict[str, Any]]:
        alerts = []
        for key, stats in self._index_stats.items():
            if stats["index_scans"] < self._min_scans:
                continue
            ratio = stats["tuples_fetched"] / max(1, stats["tuples_read"])
            if ratio < self._usage_threshold:
                alerts.append(stats)
        return alerts
