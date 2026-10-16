"""alembic/env.py — Alembic migration environment with Postgres advisory lock guard.

Issue #DB-Migration — Prevent database schema corruption when multi-replica
backend containers attempt simultaneous migrations on startup.

Advisory Lock Protocol
----------------------
Before running any migration (upgrade **or** downgrade) this module acquires
PostgreSQL session-level advisory lock 7_461_687_123 (a stable hash of the
string "stellarflow_migration_lock"). The lock is session-scoped, so it is
released automatically when the connection closes — even if the process is
killed — preventing indefinite lock hold-over.

Timeout behaviour
-----------------
If another session is already holding the lock the ``pg_try_advisory_lock``
variant is polled in a busy-wait loop with 1-second sleep intervals. After
**60 seconds** (``LOCK_TIMEOUT_SECONDS``) the process logs a CRITICAL error
and raises ``MigrationLockTimeout``, which exits the container with a non-zero
status code. This ensures:

* Only one replica runs migrations at any given moment.
* A stuck lock (e.g. replica OOM-killed mid-migration) releases itself when
  its DB session is recycled by the server — subsequent replicas will then
  acquire the lock and complete the migration normally.
* The 60-second abort prevents indefinite startup hangs visible to orchestrators
  such as Kubernetes (which will restart the container and retry).

Multi-replica safety sequence
------------------------------
1. Replica A starts, acquires advisory lock, runs migrations, releases lock.
2. Replicas B, C, … poll every 1 s. After replica A releases, one of them
   acquires, finds ``alembic_version`` already at ``head``, emits no DDL,
   releases. All replicas proceed to serve traffic.

Usage (from project root)::

    alembic -c alembic/alembic.ini upgrade head
    alembic -c alembic/alembic.ini downgrade -1
"""

from __future__ import annotations

import logging
import os
import sys
import time
from contextlib import contextmanager
from typing import Generator

from alembic import context
from sqlalchemy import create_engine, engine_from_config, pool, text

try:
    from app.models.events import _PartitionBase
    import app.models.revenue  # register revenue models into _PartitionBase.metadata
    import app.models.portfolio  # register portfolio models into _PartitionBase.metadata
    target_metadata = _PartitionBase.metadata
except ImportError:
    target_metadata = None

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logger = logging.getLogger("alembic.env")

# ---------------------------------------------------------------------------
# Advisory lock constants
# ---------------------------------------------------------------------------

# Stable 64-bit lock key: hash("stellarflow_migration_lock") clamped to
# the signed int8 range that Postgres advisory lock functions accept.
#
#   Python: abs(hash("stellarflow_migration_lock")) % (2**63)
# The value is hard-coded so it is identical across Python implementations.
_ADVISORY_LOCK_KEY: int = 7_461_687_123

# Maximum seconds to wait before aborting container startup.
LOCK_TIMEOUT_SECONDS: int = 60

# Polling interval while waiting for the advisory lock (seconds).
_POLL_INTERVAL_SECONDS: float = 1.0

# ---------------------------------------------------------------------------
# Alembic config object
# ---------------------------------------------------------------------------

# ``context.config`` is the ConfigParser wrapper around alembic.ini.
config = context.config


# ---------------------------------------------------------------------------
# Database URL resolution
# ---------------------------------------------------------------------------

def _get_database_url() -> str:
    """Return the DATABASE_URL from the environment, falling back to alembic.ini.

    Priority:
      1. ``DATABASE_URL`` environment variable (production / CI).
      2. ``sqlalchemy.url`` in alembic.ini (local dev override).

    Raises
    ------
    RuntimeError
        If neither source yields a non-empty URL.
    """
    url = os.environ.get("DATABASE_URL") or config.get_main_option("sqlalchemy.url")
    if not url or url.startswith("postgresql://user:pass@localhost"):
        env_url = os.environ.get("DATABASE_URL")
        if env_url:
            return env_url
        raise RuntimeError(
            "DATABASE_URL environment variable is not set and alembic.ini "
            "still contains the placeholder URL. "
            "Set DATABASE_URL before running migrations."
        )
    return url


# ---------------------------------------------------------------------------
# Advisory lock helpers
# ---------------------------------------------------------------------------


class MigrationLockTimeout(SystemExit):
    """Raised (and exits the process) when the 60-second advisory lock wait expires.

    Inherits from ``SystemExit`` so that container orchestrators see a non-zero
    exit code and restart the replica, which will retry the lock acquisition.
    """

    def __init__(self) -> None:
        super().__init__(
            f"[Alembic] Migration advisory lock not acquired within "
            f"{LOCK_TIMEOUT_SECONDS}s. Another replica may still be "
            "running migrations. Aborting container startup."
        )


@contextmanager
def _advisory_lock(connection) -> Generator[None, None, None]:
    """Acquire a Postgres session-level advisory lock before yielding.

    Uses ``pg_try_advisory_lock`` (non-blocking) polled every
    ``_POLL_INTERVAL_SECONDS`` second up to ``LOCK_TIMEOUT_SECONDS`` seconds.
    The session-level lock is released automatically when the connection
    closes, so there is no need for an explicit ``pg_advisory_unlock`` call —
    a process crash or OOM-kill cannot strand the lock indefinitely.

    Parameters
    ----------
    connection:
        An open SQLAlchemy ``Connection``.

    Yields
    ------
    None
        Control returns to the caller with the lock held.

    Raises
    ------
    MigrationLockTimeout
        If the lock is not acquired within ``LOCK_TIMEOUT_SECONDS`` seconds.
    """
    deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
    acquired = False
    attempt = 0

    logger.info(
        "[Alembic] Attempting to acquire advisory lock %d (timeout=%ds).",
        _ADVISORY_LOCK_KEY,
        LOCK_TIMEOUT_SECONDS,
    )

    while time.monotonic() < deadline:
        attempt += 1
        row = connection.execute(
            text("SELECT pg_try_advisory_lock(:key)"),
            {"key": _ADVISORY_LOCK_KEY},
        ).scalar()

        if row:
            acquired = True
            elapsed = time.monotonic() - (deadline - LOCK_TIMEOUT_SECONDS)
            logger.info(
                "[Alembic] Advisory lock %d acquired after %d attempt(s) (%.1fs).",
                _ADVISORY_LOCK_KEY,
                attempt,
                elapsed,
            )
            break

        remaining = deadline - time.monotonic()
        logger.warning(
            "[Alembic] Advisory lock %d held by another session. "
            "Retrying in %.0fs (%.0fs remaining before timeout).",
            _ADVISORY_LOCK_KEY,
            _POLL_INTERVAL_SECONDS,
            remaining,
        )
        time.sleep(_POLL_INTERVAL_SECONDS)

    if not acquired:
        logger.critical(
            "[Alembic] ABORT: advisory lock %d not acquired within %ds. "
            "Raising MigrationLockTimeout — container will exit with status 1.",
            _ADVISORY_LOCK_KEY,
            LOCK_TIMEOUT_SECONDS,
        )
        raise MigrationLockTimeout()

    try:
        yield
    finally:
        # Session-level advisory locks are tied to the connection lifetime.
        # Explicitly release here so the lock is freed the moment migrations
        # finish rather than waiting for full connection teardown.
        try:
            connection.execute(
                text("SELECT pg_advisory_unlock(:key)"),
                {"key": _ADVISORY_LOCK_KEY},
            )
            logger.info(
                "[Alembic] Advisory lock %d released.", _ADVISORY_LOCK_KEY
            )
        except Exception as exc:  # pragma: no cover
            # Non-fatal: the session close will release it anyway.
            logger.warning(
                "[Alembic] Could not explicitly release advisory lock %d: %s",
                _ADVISORY_LOCK_KEY,
                exc,
            )


# ---------------------------------------------------------------------------
# Offline migration mode
# ---------------------------------------------------------------------------


def run_migrations_offline() -> None:
    """Run migrations without a live database connection (generates SQL).

    In offline mode Alembic emits raw SQL to stdout so it can be reviewed
    or applied manually.  Advisory locking is skipped because there is no
    connection to execute ``pg_try_advisory_lock`` on.
    """
    url = _get_database_url()

    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # Include schemas so cross-schema objects are handled correctly.
        include_schemas=True,
    )

    logger.info("[Alembic] Running migrations in OFFLINE mode (SQL output only).")

    with context.begin_transaction():
        context.run_migrations()


# ---------------------------------------------------------------------------
# Online migration mode
# ---------------------------------------------------------------------------


def run_migrations_online() -> None:
    """Run migrations against a live database, protected by an advisory lock.

    Steps
    -----
    1. Build an engine from ``DATABASE_URL``.
    2. Open a connection.
    3. Configure non-blocking lock timeout and statement timeout.
    4. Acquire the Postgres advisory lock (60 s timeout → abort on expiry).
    5. Run migrations inside a transaction.
    6. Release the advisory lock.
    7. Close the connection.
    """
    url = _get_database_url()

    connectable = create_engine(
        url,
        # NullPool ensures each ``alembic upgrade`` invocation uses exactly
        # one connection and closes it completely on exit, releasing any
        # session-level advisory locks without relying on GC timing.
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        # Non-blocking online DDL guard: set lock_timeout (5s) and statement_timeout (60s)
        # to ensure migrations never cause prolonged table lock starvation in production.
        if getattr(getattr(connection, "dialect", None), "name", "") == "postgresql":
            connection.execute(text("SET lock_timeout = '5000ms'"))
            connection.execute(text("SET statement_timeout = '60000ms'"))

        with _advisory_lock(connection):
            context.configure(
                connection=connection,
                target_metadata=target_metadata,
                # Compare column types so Alembic can detect type-only changes.
                compare_type=True,
                # Emit COMMIT/ROLLBACK around each migration step so a failed
                # migration does not leave the schema in a partial state.
                transaction_per_migration=True,
                # Include the public schema explicitly.
                include_schemas=True,
            )

            logger.info("[Alembic] Running migrations in ONLINE mode.")

            with context.begin_transaction():
                context.run_migrations()

            logger.info("[Alembic] Migrations complete.")


# ---------------------------------------------------------------------------
# Entry point — Alembic calls this module at the top level
# ---------------------------------------------------------------------------

if getattr(context, "config", None) is not None and getattr(context.config, "config_file_name", None) is not None:
    if context.is_offline_mode():
        run_migrations_offline()
    else:
        run_migrations_online()
