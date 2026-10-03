"""conftest.py — shared fixtures for the top-level ``tests/`` directory.

A few suites that live at the top of ``tests/`` (rather than under
``tests/integration/``) still need a real PostgreSQL session — for example
``tests/test_rebalancing.py::TestRebalancingIntegration``, whose tests commit
and refresh real ORM rows.

Those suites previously errored with ``fixture 'async_db_session' not found``
because the fixtures only lived in
``tests/integration/testcontainers_fixtures/fixtures.py``, which is not on the
conftest chain for the top-level directory.

This module re-exports the same fixtures so the session/engine plumbing has a
single definition. They are lazy, so a unit test that never requests one pays
nothing and never starts a container.

Behaviour depends on the environment:

* ``TEST_DATABASE_URL`` + ``TEST_REDIS_URL`` set (the ``make test`` /
  ``docker-compose.test.yml`` path) — attach to those services.
* Unset (bare ``pytest`` on a laptop) — start ``testcontainers``
  PostgreSQL 16 and Redis 7 for the session.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make ``fixtures`` importable by bare module name, matching what
# tests/integration/testcontainers_integration/conftest.py already does.
_FIXTURES_DIR = str(Path(__file__).parent / "integration" / "testcontainers_fixtures")
if _FIXTURES_DIR not in sys.path:
    sys.path.insert(0, _FIXTURES_DIR)

# ``_set_test_env`` is deliberately NOT re-exported here. It is autouse and
# depends on postgres_container/redis_container/horizon_url, so re-exporting it
# would force a Docker-backed session onto every pure unit test in this
# directory. The integration suites that need it import it explicitly via
# tests/integration/testcontainers_integration/conftest.py.
from fixtures import (  # noqa: E402,F401
    _create_schema,
    async_db_engine,
    async_db_session,
    async_db_url,
    async_redis_client,
    db_engine,
    db_session,
    db_url,
    horizon_mock_server,
    horizon_url,
    postgres_container,
    redis_client,
    redis_client_fresh,
    redis_container,
)
