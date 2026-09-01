"""Conftest for integration tests — imports shared fixtures from testcontainers_fixtures."""

import sys
from pathlib import Path

# Ensure the fixtures directory is importable
_FIXTURES_DIR = str(Path(__file__).resolve().parent.parent / "testcontainers_fixtures")
if _FIXTURES_DIR not in sys.path:
    sys.path.insert(0, _FIXTURES_DIR)

# Import all fixtures from the shared fixtures module
from fixtures import (  # noqa: F401
    postgres_container,
    redis_container,
    horizon_mock_server,
    db_url,
    async_db_url,
    horizon_url,
    db_engine,
    db_session,
    async_db_session,
    redis_client,
    redis_client_fresh,
    async_redis_client,
    _create_schema,
    _set_test_env,
)
