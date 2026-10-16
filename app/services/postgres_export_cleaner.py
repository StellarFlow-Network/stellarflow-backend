"""Purge expired temporary export tables without waiting on active relations."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

import asyncpg


_TIMESTAMP_COLUMNS = ("created_at", "createdAt", "exported_at", "generated_at")


def _is_expired(created_at: datetime | None, now: datetime, ttl_hours: int) -> bool:
    if created_at is None:
        return False
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    return created_at < now - timedelta(hours=ttl_hours)


def _quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


async def purge_expired_temp_export_tables(
    database_url: str | None = None,
    *,
    dry_run: bool = False,
    ttl_hours: int = 24,
) -> dict[str, Any]:
    """Drop expired ``temp_export_*`` tables and refresh database statistics.

    Tables without a recognized timestamp column are skipped because PostgreSQL
    does not expose reliable relation creation times in its system catalogs.
    """
    url = database_url or os.getenv("DATABASE_URL") or os.getenv("DB_URL")
    if not url:
        raise RuntimeError("DATABASE_URL or DB_URL must be configured")
    if ttl_hours < 1:
        raise ValueError("ttl_hours must be positive")

    now = datetime.now(timezone.utc)
    result: dict[str, Any] = {
        "examined": 0,
        "dropped": [],
        "skipped_without_timestamp": [],
        "errors": [],
        "dry_run": dry_run,
        "vacuum_analyze": False,
    }
    pool = await asyncpg.create_pool(url, min_size=1, max_size=2)
    try:
        async with pool.acquire() as connection:
            tables = await connection.fetch(
                """
                SELECT n.nspname AS schema_name, c.relname AS table_name
                FROM pg_class AS c
                JOIN pg_namespace AS n ON n.oid = c.relnamespace
                WHERE c.relkind = 'r'
                  AND c.relname LIKE 'temp_export\\_%' ESCAPE '\\'
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                  AND n.nspname NOT LIKE 'pg_toast%'
                ORDER BY n.nspname, c.relname
                """
            )

            for table in tables:
                schema_name = table["schema_name"]
                table_name = table["table_name"]
                qualified_name = f"{schema_name}.{table_name}"
                result["examined"] += 1
                columns = await connection.fetch(
                    """
                    SELECT a.attname AS column_name
                    FROM pg_attribute AS a
                    JOIN pg_class AS c ON c.oid = a.attrelid
                    JOIN pg_namespace AS n ON n.oid = c.relnamespace
                    JOIN pg_type AS t ON t.oid = a.atttypid
                    WHERE n.nspname = $1 AND c.relname = $2
                      AND a.attnum > 0 AND NOT a.attisdropped
                      AND a.attname = ANY($3::text[])
                      AND t.typname IN ('timestamp', 'timestamptz')
                    ORDER BY array_position($3::text[], a.attname)
                    """,
                    schema_name,
                    table_name,
                    list(_TIMESTAMP_COLUMNS),
                )
                if not columns:
                    result["skipped_without_timestamp"].append(qualified_name)
                    continue

                timestamp_column = _quote_identifier(columns[0]["column_name"])
                created_at = await connection.fetchval(
                    f"SELECT max({timestamp_column}) FROM "
                    f"{_quote_identifier(schema_name)}.{_quote_identifier(table_name)}"
                )
                if not _is_expired(created_at, now, ttl_hours):
                    continue
                if dry_run:
                    result["dropped"].append(qualified_name)
                    continue

                try:
                    async with connection.transaction():
                        await connection.execute("SET LOCAL lock_timeout = '1s'")
                        await connection.execute(
                            f"DROP TABLE IF EXISTS "
                            f"{_quote_identifier(schema_name)}.{_quote_identifier(table_name)}"
                        )
                    result["dropped"].append(qualified_name)
                except (asyncpg.PostgresError, OSError) as exc:
                    result["errors"].append({"table": qualified_name, "error": str(exc)})

            if result["dropped"] and not dry_run:
                await connection.execute("VACUUM (ANALYZE)")
                result["vacuum_analyze"] = True
    finally:
        await pool.close()

    result["dropped_count"] = len(result["dropped"])
    result["completed_at"] = datetime.now(timezone.utc).isoformat()
    return result