"""tests/test_alembic_migrations.py — Database Migration Governance & Rollback Test Suite.

Issue #774 — Prevent broken, blocking, or un-tested database schema migrations
from merging into production.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import io
import os
import re
import sys
import time
import types
import unittest.mock as mock
from pathlib import Path
from typing import Any, Generator, List, Set
from unittest.mock import MagicMock, patch

import pytest
import sqlalchemy as sa
from sqlalchemy import create_engine, inspect, text

# ---------------------------------------------------------------------------
# Path setup
# ---------------------------------------------------------------------------
_ROOT = Path(__file__).resolve().parent.parent
_ALEMBIC_DIR = _ROOT / "alembic"
_VERSIONS_DIR = _ALEMBIC_DIR / "versions"

for _p in (str(_ROOT), str(_ALEMBIC_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# ---------------------------------------------------------------------------
# Load alembic/env.py dynamically to prevent site-packages collision
# ---------------------------------------------------------------------------
_env_path = _ALEMBIC_DIR / "env.py"
_spec = importlib.util.spec_from_file_location("alembic_env_module", str(_env_path))
_env_module = importlib.util.module_from_spec(_spec)

with patch("alembic.context") as _ctx_patch:
    _ctx_patch.is_offline_mode.return_value = False
    _ctx_patch.config = MagicMock()
    _ctx_patch.config.config_file_name = None
    _ctx_patch.config.get_main_option.return_value = "postgresql://user:pass@localhost/stellarflow"
    _spec.loader.exec_module(_env_module)

_advisory_lock = _env_module._advisory_lock
_ADVISORY_LOCK_KEY = _env_module._ADVISORY_LOCK_KEY
LOCK_TIMEOUT_SECONDS = _env_module.LOCK_TIMEOUT_SECONDS
MigrationLockTimeout = _env_module.MigrationLockTimeout
_get_database_url = _env_module._get_database_url

# Governance module imports
import app.db.governance as gov
from app.db.governance import (
    DEFAULT_LOCK_TIMEOUT_MS,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    MigrationGovernanceError,
    UncommittedSchemaChangeError,
    assert_no_uncommitted_schema_changes,
    configure_non_blocking_session,
    detect_uncommitted_schema_changes,
    validate_all_migrations,
    validate_linear_history,
    validate_migration_script,
)
from app.models.events import _PartitionBase
import app.models.revenue  # registers revenue models into _PartitionBase.metadata


# ---------------------------------------------------------------------------
# Load migration version modules
# ---------------------------------------------------------------------------
def _load_version_module(name: str) -> types.ModuleType:
    v_file = _VERSIONS_DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, str(v_file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_m0001 = _load_version_module("0001_initial_schema")
_m0002 = _load_version_module("0002_add_ledger_events_partitioned")
_m0003 = _load_version_module("0003_add_payment_routing_fx_quote")
_m0004 = _load_version_module("0004_add_revenue_yield")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _tables(engine: sa.engine.Engine) -> List[str]:
    """Return table names visible in default schema."""
    with engine.connect() as conn:
        return inspect(conn).get_table_names()


def test_initial_schema_uses_sql_expression_for_empty_array_defaults() -> None:
    migration_text = (_VERSIONS_DIR / "0001_initial_schema.py").read_text(encoding="utf-8")

    assert 'server_default="ARRAY[]::TEXT[]"' not in migration_text
    assert migration_text.count('server_default=sa.text("ARRAY[]::TEXT[]")') == 2


def _run_migration_step(engine: sa.engine.Engine, mod: types.ModuleType, action: str) -> None:
    """Execute upgrade() or downgrade() for a migration module in SQLite-compatible mode."""
    from alembic.runtime.migration import MigrationContext
    from alembic.operations import Operations

    # Patch sa.ARRAY -> sa.Text for SQLite compatibility
    orig_sa_array = sa.ARRAY
    orig_mod_array = getattr(mod.sa, "ARRAY", None)

    def _fake_array(*args, **kwargs):
        return sa.Text()

    sa.ARRAY = _fake_array
    if hasattr(mod, "sa"):
        mod.sa.ARRAY = _fake_array

    # Patch JSONB -> sa.JSON for SQLite
    orig_mod_jsonb = getattr(mod, "JSONB", None)
    mod.JSONB = sa.JSON

    try:
        with engine.connect() as conn:
            ctx = MigrationContext.configure(conn)
            with Operations.context(ctx):
                with mock.patch("alembic.op.get_bind", return_value=conn):
                    orig_create_table = mod.op.create_table

                    def _sqlite_create_table(table_name: str, *columns: Any, **kwargs: Any) -> Any:
                        for column in columns:
                            default = getattr(column, "server_default", None)
                            default_sql = str(getattr(default, "arg", default))
                            if "ARRAY[]::TEXT[]" in default_sql:
                                column.server_default = sa.text("''")
                        return orig_create_table(table_name, *columns, **kwargs)

                    # Intercept raw Postgres-specific DDL for SQLite in op.execute
                    orig_op_execute = mod.op.execute

                    def _safe_op_execute(sql, *args, **kwargs):
                        sql_str = str(sql) if not hasattr(sql, "text") else sql.text
                        if "PARTITION BY" in sql_str:
                            sql_str = re.sub(r"\s+PARTITION\s+BY\s+RANGE\s*\([^\)]+\)", "", sql_str, flags=re.IGNORECASE)
                        if "PARTITION OF" in sql_str:
                            match = re.search(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z0-9_]+)"?', sql_str, re.IGNORECASE)
                            if match:
                                tbl = match.group(1)
                                sql_str = f'CREATE TABLE IF NOT EXISTS "{tbl}" (event_hash VARCHAR(64), created_at TIMESTAMP, PRIMARY KEY (event_hash, created_at))'
                        sql_str = sql_str.replace("TIMESTAMPTZ", "TIMESTAMP").replace("JSONB", "TEXT")
                        sql_str = re.sub(r"\bnow\(\)", "CURRENT_TIMESTAMP", sql_str, flags=re.IGNORECASE)
                        if sql_str.strip():
                            conn.execute(sa.text(sql_str))

                    with mock.patch.object(mod.op, "execute", side_effect=_safe_op_execute):
                        with mock.patch.object(mod.op, "create_table", side_effect=_sqlite_create_table):
                            with mock.patch.object(
                                mod.op,
                                "create_unique_constraint",
                                side_effect=lambda name, table_name, columns, **kw: mod.op.create_index(
                                    name, table_name, columns, unique=True
                                ),
                            ):
                                if action == "upgrade":
                                    mod.upgrade()
                                else:
                                    mod.downgrade()
            conn.commit()
    finally:
        sa.ARRAY = orig_sa_array
        if hasattr(mod, "sa") and orig_mod_array is not None:
            mod.sa.ARRAY = orig_mod_array
        if orig_mod_jsonb is not None:
            mod.JSONB = orig_mod_jsonb


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture()
def mock_connection() -> MagicMock:
    conn = MagicMock()
    conn.execute.return_value.scalar.return_value = True
    return conn


@pytest.fixture()
def sqlite_engine() -> Generator[sa.engine.Engine, None, None]:
    engine = create_engine("sqlite:///:memory:", echo=False)
    yield engine
    engine.dispose()


# ---------------------------------------------------------------------------
# 1. Advisory Lock Unit Tests
# ---------------------------------------------------------------------------
class TestAdvisoryLockProtocol:
    """Validate advisory lock acquisition, release, polling, and timeout."""

    def test_lock_acquired_immediately(self, mock_connection: MagicMock) -> None:
        mock_connection.execute.return_value.scalar.return_value = True
        with _advisory_lock(mock_connection):
            pass
        calls = [str(c.args[0]) for c in mock_connection.execute.call_args_list if c.args]
        assert any("pg_try_advisory_lock" in c for c in calls)

    def test_lock_released_on_normal_exit(self, mock_connection: MagicMock) -> None:
        mock_connection.execute.return_value.scalar.return_value = True
        with _advisory_lock(mock_connection):
            pass
        calls = [str(c.args[0]) for c in mock_connection.execute.call_args_list if c.args]
        assert any("pg_advisory_unlock" in c for c in calls)

    def test_lock_released_on_exception(self, mock_connection: MagicMock) -> None:
        mock_connection.execute.return_value.scalar.return_value = True
        with pytest.raises(ValueError, match="test error"):
            with _advisory_lock(mock_connection):
                raise ValueError("test error")
        calls = [str(c.args[0]) for c in mock_connection.execute.call_args_list if c.args]
        assert any("pg_advisory_unlock" in c for c in calls)

    def test_lock_polling_retry(self, mock_connection: MagicMock) -> None:
        mock_connection.execute.return_value.scalar.side_effect = [False, False, True]
        with patch("time.sleep") as mock_sleep:
            with _advisory_lock(mock_connection):
                pass
        assert mock_sleep.call_count == 2

    def test_lock_timeout_raises_migration_lock_timeout(self, mock_connection: MagicMock) -> None:
        mock_connection.execute.return_value.scalar.return_value = False
        fake_times = [0.0] + [LOCK_TIMEOUT_SECONDS + 5.0] * 20
        with patch("time.monotonic", side_effect=fake_times):
            with patch("time.sleep"):
                with pytest.raises(MigrationLockTimeout):
                    with _advisory_lock(mock_connection):
                        pass

    def test_unlock_not_called_on_timeout(self, mock_connection: MagicMock) -> None:
        mock_connection.execute.return_value.scalar.return_value = False
        fake_times = [0.0] + [LOCK_TIMEOUT_SECONDS + 5.0] * 20
        with patch("time.monotonic", side_effect=fake_times):
            with patch("time.sleep"):
                with pytest.raises(MigrationLockTimeout):
                    with _advisory_lock(mock_connection):
                        pass
        calls = [str(c.args[0]) for c in mock_connection.execute.call_args_list if c.args]
        assert not any("pg_advisory_unlock" in c for c in calls)


# ---------------------------------------------------------------------------
# 2. Non-Blocking Session Configuration Tests
# ---------------------------------------------------------------------------
class TestNonBlockingSessionConfiguration:
    """Validate lock_timeout and statement_timeout enforcement for PostgreSQL."""

    def test_configure_non_blocking_session_executes_set_commands(self) -> None:
        mock_conn = MagicMock()
        mock_conn.dialect.name = "postgresql"

        configure_non_blocking_session(mock_conn, lock_timeout_ms=5000, statement_timeout_ms=60000)

        calls = [str(c.args[0]) for c in mock_conn.execute.call_args_list if c.args]
        assert any("SET lock_timeout = '5000ms'" in c for c in calls)
        assert any("SET statement_timeout = '60000ms'" in c for c in calls)

    def test_configure_non_blocking_session_skips_non_postgres(self) -> None:
        mock_conn = MagicMock()
        mock_conn.dialect.name = "sqlite"

        configure_non_blocking_session(mock_conn)
        assert mock_conn.execute.call_count == 0


# ---------------------------------------------------------------------------
# 3. Database URL Resolution Tests
# ---------------------------------------------------------------------------
class TestDatabaseUrlResolution:
    def test_reads_database_url_from_env(self) -> None:
        url = "postgresql://usr:pwd@host:5432/db"
        with patch.dict(os.environ, {"DATABASE_URL": url}):
            assert _get_database_url() == url

    def test_raises_when_only_placeholder_url_present(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop("DATABASE_URL", None)
            with patch.object(
                _env_module.config,
                "get_main_option",
                return_value="postgresql://user:pass@localhost/stellarflow",
            ):
                with pytest.raises(RuntimeError, match="DATABASE_URL"):
                    _get_database_url()


# ---------------------------------------------------------------------------
# 4. Individual Migration Round-Trip Tests (0001, 0002, 0003, 0004)
# ---------------------------------------------------------------------------
class TestMigration0001InitialSchema:
    def test_upgrade_and_downgrade_round_trip(self, sqlite_engine: sa.engine.Engine) -> None:
        _run_migration_step(sqlite_engine, _m0001, "upgrade")
        tables = _tables(sqlite_engine)
        assert "Currency" in tables
        assert "PriceHistory" in tables
        assert "Relayer" in tables
        assert "MultiSigPrice" in tables

        _run_migration_step(sqlite_engine, _m0001, "downgrade")
        remaining = [t for t in _tables(sqlite_engine) if t != "alembic_version"]
        assert remaining == []


class TestMigration0002LedgerEvents:
    def test_upgrade_and_downgrade_round_trip(self, sqlite_engine: sa.engine.Engine) -> None:
        _run_migration_step(sqlite_engine, _m0002, "upgrade")
        tables = _tables(sqlite_engine)
        assert "ledger_events" in tables

        _run_migration_step(sqlite_engine, _m0002, "downgrade")
        remaining = [t for t in _tables(sqlite_engine) if t != "alembic_version"]
        assert "ledger_events" not in remaining


class TestMigration0003PaymentRoutingFxQuote:
    def test_upgrade_and_downgrade_round_trip(self, sqlite_engine: sa.engine.Engine) -> None:
        _run_migration_step(sqlite_engine, _m0003, "upgrade")
        tables = _tables(sqlite_engine)
        assert "payment_route" in tables
        assert "fx_quote" in tables

        _run_migration_step(sqlite_engine, _m0003, "downgrade")
        remaining = [t for t in _tables(sqlite_engine) if t != "alembic_version"]
        assert "payment_route" not in remaining
        assert "fx_quote" not in remaining


class TestMigration0004RevenueYield:
    def test_upgrade_and_downgrade_round_trip(self, sqlite_engine: sa.engine.Engine) -> None:
        _run_migration_step(sqlite_engine, _m0004, "upgrade")
        tables = _tables(sqlite_engine)
        assert "flash_loan_revenue" in tables
        assert "protocol_yield_snapshot" in tables

        _run_migration_step(sqlite_engine, _m0004, "downgrade")
        remaining = [t for t in _tables(sqlite_engine) if t != "alembic_version"]
        assert "flash_loan_revenue" not in remaining
        assert "protocol_yield_snapshot" not in remaining


# ---------------------------------------------------------------------------
# 5. Full Sequential Pipeline Round-Trip (base -> head -> base -> head)
# ---------------------------------------------------------------------------
class TestFullMigrationPipelineRoundTrip:
    """Verify that the full chain of migrations runs forward, backward, and forward again cleanly."""

    def test_full_pipeline_round_trip(self, sqlite_engine: sa.engine.Engine) -> None:
        # 1. Upgrade all 0001 -> 0002 -> 0003 -> 0004
        _run_migration_step(sqlite_engine, _m0001, "upgrade")
        _run_migration_step(sqlite_engine, _m0002, "upgrade")
        _run_migration_step(sqlite_engine, _m0003, "upgrade")
        _run_migration_step(sqlite_engine, _m0004, "upgrade")

        tables_head = set(_tables(sqlite_engine))
        assert "Currency" in tables_head
        assert "ledger_events" in tables_head
        assert "payment_route" in tables_head
        assert "fx_quote" in tables_head
        assert "flash_loan_revenue" in tables_head
        assert "protocol_yield_snapshot" in tables_head

        # 2. Downgrade all 0004 -> 0003 -> 0002 -> 0001
        _run_migration_step(sqlite_engine, _m0004, "downgrade")
        _run_migration_step(sqlite_engine, _m0003, "downgrade")
        _run_migration_step(sqlite_engine, _m0002, "downgrade")
        _run_migration_step(sqlite_engine, _m0001, "downgrade")

        remaining = [t for t in _tables(sqlite_engine) if t != "alembic_version"]
        assert remaining == [], f"Tables remaining after full downgrade: {remaining}"

        # 3. Re-upgrade to head
        _run_migration_step(sqlite_engine, _m0001, "upgrade")
        _run_migration_step(sqlite_engine, _m0002, "upgrade")
        _run_migration_step(sqlite_engine, _m0003, "upgrade")
        _run_migration_step(sqlite_engine, _m0004, "upgrade")

        tables_reup = set(_tables(sqlite_engine))
        assert tables_head.issubset(tables_reup)


# ---------------------------------------------------------------------------
# 6. Static AST Governance & Non-Blocking Rules Validation
# ---------------------------------------------------------------------------
class TestMigrationGovernanceRules:
    """Validate all migration files against non-blocking online schema governance rules."""

    def test_all_migrations_pass_governance(self) -> None:
        violations = validate_all_migrations(_VERSIONS_DIR)
        assert violations == {}, f"Governance violations detected: {violations}"

    def test_visitor_detects_blocking_not_null_column_without_default(self) -> None:
        code = """
from alembic import op
import sqlalchemy as sa

revision: str = '9999'
down_revision: str = '0004'

def upgrade():
    op.add_column('existing_table', sa.Column('unsafe_col', sa.String(50), nullable=False))

def downgrade():
    op.drop_column('existing_table', 'unsafe_col')
"""
        tree = ast.parse(code)
        visitor = gov.MigrationAstVisitor("test_blocking.py")
        visitor.visit(tree)
        assert len(visitor.errors) >= 1
        assert any("Blocking DDL detected" in e for e in visitor.errors)

    def test_visitor_detects_missing_downgrade(self) -> None:
        code = """
from alembic import op
revision: str = '9999'
down_revision: str = '0004'
def upgrade():
    pass
"""
        tree = ast.parse(code)
        visitor = gov.MigrationAstVisitor("test_missing_down.py")
        visitor.visit(tree)
        assert not visitor.has_downgrade


# ---------------------------------------------------------------------------
# 7. Uncommitted Schema Changes (Drift Detection) Tests
# ---------------------------------------------------------------------------
class TestSchemaDriftDetection:
    """Verify that uncommitted schema differences between models and DB are detected."""

    def test_no_uncommitted_changes_on_synced_schema(self, sqlite_engine: sa.engine.Engine) -> None:
        # Set up tables for _PartitionBase models
        _run_migration_step(sqlite_engine, _m0001, "upgrade")
        _run_migration_step(sqlite_engine, _m0002, "upgrade")
        _run_migration_step(sqlite_engine, _m0003, "upgrade")
        _run_migration_step(sqlite_engine, _m0004, "upgrade")

        with sqlite_engine.connect() as conn:
            diffs = detect_uncommitted_schema_changes(conn, _PartitionBase.metadata)
            assert diffs == [], f"Unexpected drift detected on synced schema: {diffs}"

    def test_drift_detector_catches_uncommitted_table(self, sqlite_engine: sa.engine.Engine) -> None:
        # Schema only has 0001, but metadata expects ledger_events from 0002
        _run_migration_step(sqlite_engine, _m0001, "upgrade")

        with sqlite_engine.connect() as conn:
            with pytest.raises(UncommittedSchemaChangeError) as exc_info:
                assert_no_uncommitted_schema_changes(conn, _PartitionBase.metadata)
            assert "uncommitted schema change" in str(exc_info.value).lower()


# ---------------------------------------------------------------------------
# 8. Linear History Validation
# ---------------------------------------------------------------------------
class TestLinearMigrationHistory:
    def test_single_linear_head_and_base(self) -> None:
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        cfg = Config(str(_ALEMBIC_DIR / "alembic.ini"))
        script_dir = ScriptDirectory.from_config(cfg)
        validate_linear_history(script_dir)
        heads = script_dir.get_heads()
        assert len(heads) == 1
        assert heads[0] == "0004"
