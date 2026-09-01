"""conftest.py — pytest path configuration for the StellarFlow backend.

Adds ``src/`` and ``app/`` to ``sys.path`` so that imports resolve when pytest
is invoked from the project root (e.g. ``python -m pytest tests/``).

Also registers custom markers for the integration test suite.
"""
import sys
from pathlib import Path

# Insert src/ at the front of sys.path once, idempotently.
_SRC = str(Path(__file__).parent / "src")
if _SRC not in sys.path:
    sys.path.insert(0, _SRC)

# Insert the project root so that ``app.*`` imports resolve.
_ROOT = str(Path(__file__).parent)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


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
