"""app/services/redis_memory_monitor.py — Automated Redis cache eviction and memory monitoring.

Issue #1315:
- Monitor Redis memory usage via `INFO memory` in Celery beat task.
- Execute targeted key evictions on volatile cache namespaces if memory exceeds 85%.
- Send warning alert notifications to devops channels (Discord, Slack, custom webhook).
- Protect critical session and transaction keys from eviction.
"""

from __future__ import annotations

import fnmatch
import json
import os
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional, Sequence

try:
    import structlog
    log = structlog.get_logger(__name__)
except ImportError:
    import logging
    log = logging.getLogger(__name__)

# Default namespaces considered volatile and safe to evict during memory pressure.
# These mirror the key prefixes this codebase actually writes (see
# src/cache/redis_cache.py and app/services/proof_verification_engine.py).
DEFAULT_VOLATILE_CACHE_NAMESPACES: list[str] = [
    "stellarflow:zk:proof:*",
    "stellarflow:cache:*",
    "analytics:*",
    "cache:analytics:*",
    "volatile:*",
]

# Patterns that MUST NEVER be evicted under any circumstances. Both the
# ``stellarflow:``-prefixed keys this codebase writes and the legacy bare
# prefixes are listed; matching is case-insensitive glob (fnmatch), so
# ``*nonce*`` works as expected.
CRITICAL_PROTECTED_PATTERNS: list[str] = [
    "stellarflow:auth:*",
    "stellarflow:nonce:*",
    "stellarflow:nullifier*",
    "stellarflow:webhook:*",
    "stellarflow:dlq*",
    "stellarflow:vault:lock:*",
    "stellarflow:sessions:*",
    "stellarflow:session:*",
    "stellarflow:lockdown:*",
    "stellarflow:ledger-events",
    "stellarflow:zk:merkle-root*",
    "stellarflow:state:root",
    "session:*",
    "auth:*",
    "nonce:*",
    "lock:*",
    "relayer:*",
    "nullifier:*",
    "webhook:*",
    "dlq:*",
    "user_session:*",
]

# Memory alert cooldown tracking (in-memory)
_last_alert_timestamp: float = 0.0
_warned_unbounded = False


def _warn_unbounded_memory() -> None:
    """Warn once when Redis has no memory budget, so the monitor is a no-op."""
    global _warned_unbounded
    if _warned_unbounded:
        return
    _warned_unbounded = True
    log.warning(
        "redis_memory_monitor.unbounded_memory",
        hint="set REDIS_MAX_MEMORY_BYTES or configure Redis maxmemory to enable monitoring",
    )


def _reset_unbounded_warning() -> None:
    global _warned_unbounded
    _warned_unbounded = False

# Documented supported range for REDIS_MEMORY_THRESHOLD_PERCENT.
MIN_THRESHOLD_PERCENT = 1.0
MAX_THRESHOLD_PERCENT = 100.0


def reset_alert_cooldown() -> None:
    """Reset the alert cooldown timer (primarily for testing)."""
    global _last_alert_timestamp
    _last_alert_timestamp = 0.0


def _redact_url(url: str) -> str:
    """Return a log-safe version of a webhook URL (never the token path)."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return "<invalid-url>"
    if not parts.hostname:
        return "<invalid-url>"
    tail = (parts.path.rstrip("/").rsplit("/", 1)[-1] or "")[-4:]
    return f"{parts.scheme}://{parts.hostname}/…{tail}"


def _resolve_threshold(explicit: float) -> float:
    """Resolve the alert/eviction threshold, clamped to 1..100.

    The environment variable wins over the task argument so operators can tune
    it without a deploy; invalid or out-of-range values never disable the
    safety bounds.
    """
    configured = os.getenv("REDIS_MEMORY_THRESHOLD_PERCENT")
    if configured is not None and configured.strip():
        try:
            value = float(configured)
        except ValueError:
            log.warning("redis_memory_monitor.invalid_threshold_ignored", value=configured)
            return _clamp_threshold(explicit)
        clamped = _clamp_threshold(value)
        if clamped != value:
            log.warning(
                "redis_memory_monitor.threshold_clamped",
                configured=value,
                clamped=clamped,
            )
        return clamped
    return _clamp_threshold(explicit)


def _clamp_threshold(value: float) -> float:
    return max(MIN_THRESHOLD_PERCENT, min(MAX_THRESHOLD_PERCENT, float(value)))


@dataclass
class MemoryStats:
    """Snapshot of Redis memory utilization from INFO memory."""

    used_memory_bytes: int
    maxmemory_bytes: int
    utilization_ratio: float
    utilization_percent: float
    is_above_threshold: bool
    used_memory_human: str
    maxmemory_human: str


@dataclass
class EvictionReport:
    """Report summarizing eviction execution."""

    threshold_percent: float
    memory_before: MemoryStats
    memory_after: MemoryStats
    evicted_keys_count: int = 0
    scanned_keys_count: int = 0
    namespaces_scanned: list[str] = field(default_factory=list)
    alert_sent: bool = False
    alert_details: dict[str, Any] = field(default_factory=dict)
    stopped_early: bool = False


def _bytes_to_human(byte_count: int) -> str:
    """Convert bytes to human-readable string (e.g. 120.5 MB)."""
    if byte_count < 1024:
        return f"{byte_count} B"
    for unit in ["KB", "MB", "GB", "TB"]:
        byte_count /= 1024.0
        if byte_count < 1024.0:
            return f"{byte_count:.2f} {unit}"
    return f"{byte_count:.2f} PB"


class RedisMemoryMonitor:
    """Monitors Redis memory utilization and executes safe, bounded eviction

    when usage exceeds configured thresholds.
    """

    def __init__(
        self,
        redis_client: Optional[Any] = None,
        redis_url: Optional[str] = None,
        threshold_percent: float = 85.0,
        volatile_namespaces: Optional[Sequence[str]] = None,
        protected_patterns: Optional[Sequence[str]] = None,
        alert_webhook_urls: Optional[Sequence[str]] = None,
        alert_cooldown_seconds: float = 300.0,
    ) -> None:
        self._redis = redis_client
        self._redis_url = redis_url or os.getenv("REDIS_URL", "redis://localhost:6379")

        self.threshold_percent = _resolve_threshold(threshold_percent)

        if volatile_namespaces is not None:
            self.volatile_namespaces = self._sanitize_namespaces(volatile_namespaces)
        else:
            env_ns = os.getenv("REDIS_VOLATILE_CACHE_NAMESPACES")
            if env_ns:
                self.volatile_namespaces = self._sanitize_namespaces(
                    [ns.strip() for ns in env_ns.split(",") if ns.strip()]
                )
            else:
                self.volatile_namespaces = list(DEFAULT_VOLATILE_CACHE_NAMESPACES)

        if protected_patterns is not None:
            self.protected_patterns = list(protected_patterns)
        else:
            env_prot = os.getenv("REDIS_PROTECTED_KEY_PATTERNS")
            if env_prot:
                self.protected_patterns = [p.strip() for p in env_prot.split(",") if p.strip()]
            else:
                self.protected_patterns = list(CRITICAL_PROTECTED_PATTERNS)

        self.alert_webhook_urls = (
            list(alert_webhook_urls)
            if alert_webhook_urls is not None
            else self._discover_webhook_urls()
        )
        self.alert_cooldown_seconds = alert_cooldown_seconds

    def _discover_webhook_urls(self) -> list[str]:
        """Discover configured alert webhook destinations from environment."""
        urls: list[str] = []
        for key in ["DEVOPS_ALERT_WEBHOOK_URL", "ALERT_WEBHOOK_URL", "DISCORD_WEBHOOK_URL", "SLACK_WEBHOOK_URL"]:
            val = os.getenv(key, "").strip()
            if val and val not in urls:
                urls.append(val)
        return urls

    @staticmethod
    def _sanitize_namespaces(patterns: Sequence[str]) -> list[str]:
        """Drop empty and unrestricted patterns (a bare ``*`` deletes everything)."""
        cleaned: list[str] = []
        for pattern in patterns:
            pattern = pattern.strip()
            if not pattern:
                continue
            if pattern in {"*", "**"}:
                log.warning("redis_memory_monitor.unsafe_namespace_ignored", pattern=pattern)
                continue
            cleaned.append(pattern)
        return cleaned

    def get_redis_client(self) -> Any:
        """Get or initialize the underlying Redis client."""
        if self._redis is not None:
            return self._redis
        import redis
        self._redis = redis.Redis.from_url(
            self._redis_url,
            decode_responses=True,
            socket_timeout=5.0,
            socket_connect_timeout=5.0,
        )
        return self._redis

    def is_protected_key(self, key: str) -> bool:
        """Check if a key must be preserved and NEVER evicted.

        Any key matching a protected glob (case-insensitive) or containing
        'session' is safe.
        """
        key_lower = key.lower()
        if "session" in key_lower:
            return True
        return any(
            fnmatch.fnmatchcase(key_lower, pattern.lower())
            for pattern in self.protected_patterns
        )

    @staticmethod
    def _evictable_keys(client: Any, keys: list[str]) -> list[str]:
        """Keep only keys with a positive TTL (i.e. genuinely volatile)."""
        if not keys:
            return []
        try:
            pipe = client.pipeline(transaction=False)
            for key in keys:
                pipe.pttl(key)
            ttls = pipe.execute()
        except AttributeError:
            # Client without pipelining: fall back to namespace scoping only.
            return keys
        return [key for key, ttl in zip(keys, ttls) if int(ttl) > 0]

    def get_memory_stats(self) -> MemoryStats:
        """Fetch memory statistics via Redis `INFO memory` command."""
        client = self.get_redis_client()
        info: dict[str, Any] = client.info("memory")

        used_memory = int(info.get("used_memory", 0))
        maxmemory = int(info.get("maxmemory", 0))

        # When maxmemory is not configured (0), check total system memory or env fallback
        if maxmemory <= 0:
            env_max = os.getenv("REDIS_MAX_MEMORY_BYTES")
            if env_max:
                try:
                    maxmemory = int(env_max)
                except ValueError:
                    maxmemory = 0
            if maxmemory <= 0:
                maxmemory = int(info.get("total_system_memory", 0))

        if maxmemory > 0:
            ratio = used_memory / maxmemory
            percent = ratio * 100.0
            _reset_unbounded_warning()
        else:
            ratio = 0.0
            percent = 0.0
            _warn_unbounded_memory()

        is_above = percent >= self.threshold_percent if maxmemory > 0 else False

        return MemoryStats(
            used_memory_bytes=used_memory,
            maxmemory_bytes=maxmemory,
            utilization_ratio=ratio,
            utilization_percent=percent,
            is_above_threshold=is_above,
            used_memory_human=_bytes_to_human(used_memory),
            maxmemory_human=_bytes_to_human(maxmemory) if maxmemory > 0 else "unbounded",
        )

    def evict_volatile_keys(
        self,
        batch_size: int = 100,
        max_evictions: int = 5000,
        target_reduction_percent: Optional[float] = None,
    ) -> EvictionReport:
        """Execute targeted eviction of volatile cache keys until memory is

        brought below threshold or all namespaces are exhausted.
        """
        client = self.get_redis_client()
        mem_before = self.get_memory_stats()

        target_percent = target_reduction_percent or (self.threshold_percent - 5.0)

        report = EvictionReport(
            threshold_percent=self.threshold_percent,
            memory_before=mem_before,
            memory_after=mem_before,
            evicted_keys_count=0,
            scanned_keys_count=0,
            namespaces_scanned=[],
        )

        # If memory is within safe bounds, skip eviction
        if not mem_before.is_above_threshold:
            log.info(
                "redis_memory_monitor.memory_healthy",
                used=mem_before.used_memory_human,
                max=mem_before.maxmemory_human,
                utilization_percent=round(mem_before.utilization_percent, 2),
                threshold=self.threshold_percent,
            )
            return report

        log.warning(
            "redis_memory_monitor.threshold_exceeded_starting_eviction",
            used=mem_before.used_memory_human,
            max=mem_before.maxmemory_human,
            utilization_percent=round(mem_before.utilization_percent, 2),
            threshold=self.threshold_percent,
            target_percent=target_percent,
        )

        total_evicted = 0
        total_scanned = 0

        for namespace in self.volatile_namespaces:
            report.namespaces_scanned.append(namespace)
            cursor = 0

            while True:
                cursor, keys = client.scan(cursor=cursor, match=namespace, count=batch_size)
                total_scanned += len(keys)

                # Filter out protected / critical session keys, then keep only
                # keys that actually expire: "volatile" is defined by a TTL.
                eligible_keys = [k for k in keys if not self.is_protected_key(k)]
                eligible_keys = self._evictable_keys(client, eligible_keys)

                if eligible_keys:
                    # Limit eviction to remaining quota
                    remaining_quota = max_evictions - total_evicted
                    if remaining_quota <= 0:
                        report.stopped_early = True
                        break
                    if len(eligible_keys) > remaining_quota:
                        eligible_keys = eligible_keys[:remaining_quota]

                    # Prefer non-blocking unlink when supported, fall back to delete
                    try:
                        deleted = client.unlink(*eligible_keys)
                    except AttributeError:
                        deleted = client.delete(*eligible_keys)

                    total_evicted += int(deleted or 0)

                # Check if we should stop early:
                # 1. Cap reached
                if total_evicted >= max_evictions:
                    report.stopped_early = True
                    break

                # 2. Check if memory recovered below target
                current_mem = self.get_memory_stats()
                if current_mem.maxmemory_bytes > 0 and current_mem.utilization_percent < target_percent:
                    report.stopped_early = True
                    break

                # 3. Scan iteration finished
                if cursor == 0 or cursor == "0":
                    break

            if report.stopped_early:
                break

        mem_after = self.get_memory_stats()
        report.memory_after = mem_after
        report.evicted_keys_count = total_evicted
        report.scanned_keys_count = total_scanned

        log.info(
            "redis_memory_monitor.eviction_complete",
            evicted_keys=total_evicted,
            scanned_keys=total_scanned,
            memory_before_percent=round(mem_before.utilization_percent, 2),
            memory_after_percent=round(mem_after.utilization_percent, 2),
        )

        # Trigger DevOps alert because threshold was crossed
        alert_sent = self.send_devops_alert(report)
        report.alert_sent = alert_sent

        return report

    def send_devops_alert(self, report: EvictionReport, force: bool = False) -> bool:
        """Send warning alert notification to configured DevOps channels."""
        global _last_alert_timestamp

        now = time.time()
        if not force and (now - _last_alert_timestamp) < self.alert_cooldown_seconds:
            log.info(
                "redis_memory_monitor.alert_cooldown_active",
                elapsed=round(now - _last_alert_timestamp, 1),
                cooldown=self.alert_cooldown_seconds,
            )
            return False

        if not self.alert_webhook_urls:
            log.warning("redis_memory_monitor.no_webhook_urls_configured")
            return False

        severity = "critical" if report.memory_after.utilization_percent >= 95.0 else "warning"
        status_msg = (
            "Mitigated (evicted keys brought usage down)"
            if not report.memory_after.is_above_threshold
            else "Action Required (memory remains above threshold after eviction)"
        )

        payload = {
            "alert_type": "redis_memory_pressure",
            "severity": severity,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "title": f"Redis Memory Utilization Alert ({round(report.memory_before.utilization_percent, 1)}%)",
            "status": status_msg,
            "metrics": {
                "threshold_percent": report.threshold_percent,
                "initial_utilization_percent": round(report.memory_before.utilization_percent, 2),
                "current_utilization_percent": round(report.memory_after.utilization_percent, 2),
                "used_memory": report.memory_after.used_memory_human,
                "max_memory": report.memory_after.maxmemory_human,
                "evicted_keys": report.evicted_keys_count,
                "scanned_keys": report.scanned_keys_count,
                "namespaces": report.namespaces_scanned,
            },
            "message": (
                f"Redis memory exceeded safe threshold of {report.threshold_percent}%. "
                f"Automated maintenance evicted {report.evicted_keys_count} volatile analytics keys. "
                f"Current memory: {report.memory_after.used_memory_human} / {report.memory_after.maxmemory_human} "
                f"({round(report.memory_after.utilization_percent, 1)}%)."
            ),
        }

        any_sent = False
        for url in self.alert_webhook_urls:
            ok = self._post_webhook(url, payload)
            if ok:
                any_sent = True

        if any_sent:
            _last_alert_timestamp = now
            log.info("redis_memory_monitor.alert_delivered", severity=severity)

        report.alert_details = {
            "delivered": any_sent,
            "targets": [_redact_url(url) for url in self.alert_webhook_urls],
        }
        return any_sent

    def _post_webhook(self, url: str, payload: dict[str, Any]) -> bool:
        """Deliver payload to webhook URL (formatting for Slack / Discord / Generic)."""
        body = json.dumps(payload).encode("utf-8")

        # Format specifically if Slack or Discord
        if "hooks.slack.com" in url:
            slack_body = {
                "text": f":warning: *{payload['title']}*\n{payload['message']}\n*Status*: {payload['status']}"
            }
            body = json.dumps(slack_body).encode("utf-8")
        elif "discord.com" in url or "discordapp.com" in url:
            discord_body = {
                "content": f"⚠️ **{payload['title']}**\n{payload['message']}\n**Status**: {payload['status']}"
            }
            body = json.dumps(discord_body).encode("utf-8")

        req = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json", "User-Agent": "StellarFlow-RedisMonitor/1.0"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                return 200 <= resp.status < 300
        except Exception as exc:
            log.warning(
                "redis_memory_monitor.webhook_failed",
                target=_redact_url(url),
                error=str(exc),
            )
            return False


def run_redis_memory_monitor(
    redis_client: Optional[Any] = None,
    threshold_percent: float = 85.0,
    batch_size: int = 100,
    max_evictions: int = 5000,
) -> dict[str, Any]:
    """Top-level invocation helper for Celery task or CLI maintenance."""
    monitor = RedisMemoryMonitor(redis_client=redis_client, threshold_percent=threshold_percent)
    report = monitor.evict_volatile_keys(batch_size=batch_size, max_evictions=max_evictions)
    return {
        "status": "success",
        "threshold_percent": report.threshold_percent,
        "initial_percent": report.memory_before.utilization_percent,
        "final_percent": report.memory_after.utilization_percent,
        "evicted_keys": report.evicted_keys_count,
        "alert_sent": report.alert_sent,
        "stopped_early": report.stopped_early,
    }
