"""Database compatibility and request-scoped batching helpers for GraphQL."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError


ENTITY_TABLES = {
    "pool": ("pools", "pool"),
    "transaction": ("transactions", "transaction", "ledger_events"),
    "account": ("accounts", "account"),
    "governance_proposal": (
        "governance_proposals",
        "governance_proposal",
        "proposals",
    ),
}


def _value(row: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(row, dict) and name in row:
            return row[name]
        try:
            value = getattr(row, name)
        except AttributeError:
            continue
        if value is not None:
            return value
    return default


def normalize(entity: str, row: Any) -> dict[str, Any]:
    """Map likely Prisma/SQLAlchemy names into the public GraphQL contract."""
    identifier = _value(row, "id", "address", "pool_id", "hash", "tx_hash", "event_hash", default="")
    result = {"id": str(identifier)}
    mappings = {
        "name": ("name", "label"),
        "address": ("address", "account_address", "public_key"),
        "status": ("status", "state"),
        "amount": ("amount", "value", "liquidity"),
        "hash": ("hash", "tx_hash", "transaction_hash", "event_hash"),
        "from_address": ("from_address", "sender", "source"),
        "to_address": ("to_address", "receiver", "destination"),
        "type": ("type", "event_type", "transaction_type"),
        "title": ("title", "name"),
        "description": ("description", "summary"),
        "proposer": ("proposer", "proposer_address", "author"),
        "votes_for": ("votes_for", "for_votes"),
        "votes_against": ("votes_against", "against_votes"),
    }
    for field, names in mappings.items():
        result[field] = _value(row, *names)
    return result


class GraphQLRepository:
    """Read-only repository tolerant of absent or evolving database models."""

    def __init__(self, session: Any = None):
        self.session = session

    async def _query(self, entity: str, ids: Iterable[str] | None = None) -> list[dict[str, Any]]:
        if self.session is None:
            try:
                from app.db.session import async_session_factory
            except (ImportError, RuntimeError):
                return []
            async with async_session_factory() as session:
                return await GraphQLRepository(session)._query(entity, ids)
        for table in ENTITY_TABLES[entity]:
            try:
                query = f"SELECT * FROM {table}"
                parameters: dict[str, Any] = {}
                if ids:
                    # A bounded set of positional parameters keeps this compatible with asyncpg.
                    id_values = list(ids)
                    placeholders = ", ".join(f":id_{index}" for index, _ in enumerate(id_values))
                    query += f" WHERE CAST(id AS TEXT) IN ({placeholders})"
                    parameters = {f"id_{index}": value for index, value in enumerate(id_values)}
                query += " LIMIT 100"
                result = await self.session.execute(text(query), parameters)
                return [normalize(entity, row) for row in result.mappings().all()]
            except (SQLAlchemyError, RuntimeError, AttributeError, KeyError, TypeError, ValueError):
                continue
        return []

    async def list(self, entity: str) -> list[dict[str, Any]]:
        return await self._query(entity)

    async def by_ids(self, entity: str, ids: list[str]) -> list[dict[str, Any] | None]:
        if not ids:
            return []
        rows = await self._query(entity, ids)
        by_id = {row["id"]: row for row in rows}
        return [by_id.get(item) for item in ids]