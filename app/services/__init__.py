import warnings

try:
    from .nonce_manager import NonceManager, RelayerPool, nonce_manager
except ImportError:
    NonceManager = None  # type: ignore
    RelayerPool = None  # type: ignore
    nonce_manager = None  # type: ignore

# ``src/analytics/__init__.py`` currently contains a corrupted block (379
# duplicated ``from .treasury_swap import (...)`` copies) and raises
# IndentationError. Keep the package importable, but surface the problem instead
# of hiding it: the settlement task will still fail loudly when it uses this.
try:
    from .fiat_settlement import DatabaseSettlementLatencyWorker
except (ImportError, SyntaxError) as exc:  # pragma: no cover - depends on a broken tree
    DatabaseSettlementLatencyWorker = None  # type: ignore
    warnings.warn(
        f"DatabaseSettlementLatencyWorker unavailable: {exc}",
        RuntimeWarning,
        stacklevel=2,
    )

from .redis_memory_monitor import (
    DEFAULT_VOLATILE_CACHE_NAMESPACES,
    CRITICAL_PROTECTED_PATTERNS,
    EvictionReport,
    MemoryStats,
    RedisMemoryMonitor,
    run_redis_memory_monitor,
)

__all__ = [
    "NonceManager",
    "RelayerPool",
    "nonce_manager",
    "DatabaseSettlementLatencyWorker",
    "RedisMemoryMonitor",
    "run_redis_memory_monitor",
    "MemoryStats",
    "EvictionReport",
]
