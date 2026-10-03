"""conftest.py — pytest path configuration for the StellarFlow backend.

Adds ``src/``, ``app/`` and ``tests/`` to ``sys.path`` so that imports resolve
when pytest is invoked from the project root (e.g. ``python -m pytest tests/``).

``tests/`` is included because several suites import test-local helper modules
by their bare module name (e.g. ``from _horizon_xdr_encoder import ...``),
which only resolves when the tests directory itself is importable.

Also registers custom markers for the integration test suite and skips modules
that can no longer be collected (see ``COLLECT_IGNORE``).
"""
import sys
from pathlib import Path

_TESTS_DIR = Path(__file__).parent / "tests"

# Insert src/ at the front of sys.path once, idempotently.
_SRC = str(Path(__file__).parent / "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

# Insert the project root so that ``app.*`` imports resolve.
_ROOT = str(Path(__file__).parent)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# Insert tests/ so test-local helper modules import by bare name.
if str(_TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(_TESTS_DIR))


# ---------------------------------------------------------------------------
# Modules that are known not to collect
# ---------------------------------------------------------------------------
#
# Listed explicitly rather than silently ignored so the exclusions stay
# auditable. These suites were written against APIs that no longer exist:
# commit 31624c2b ("Fix issue #799") removed AdaptiveTimeoutController,
# AsyncConnectionKeepAlive and ConnectionPoolHealthMonitor from
# src/database/connection.py without deleting their tests.
#
# Delete an entry from this list once the corresponding module is either
# restored or the test is retired — a stale entry would hide new failures.
COLLECT_IGNORE = [
    "test_adaptive_timeout_controller.py",
    "test_connection_keepalive.py",
    "test_pool_recovery.py",
]


def pytest_configure(config):
    """Register custom markers for the integration test suite."""
    config.addinivalue_line(
        "markers",
        "integration: marks tests as integration tests (require Docker containers)",
    )
    config.addinivalue_line(
        "markers",
        "e2e_layer(name): marks a layer E2E test",
    )


def pytest_ignore_collect(collection_path, config):
    """Skip modules listed in :data:`COLLECT_IGNORE`."""
    if collection_path.name in COLLECT_IGNORE:
        return True
    return None
