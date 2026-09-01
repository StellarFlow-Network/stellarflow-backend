"""Focused tests for the issue #788 GraphQL boundary."""

import asyncio

import pytest

pytest.importorskip("strawberry")
pytest.importorskip("sqlalchemy")

from app.graphql.repository import GraphQLRepository
from app.graphql.schema import _make_loader, schema


class _Mappings:
    def __init__(self, rows):
        self.rows = rows

    def all(self):
        return self.rows


class _Result:
    def __init__(self, rows):
        self.rows = rows

    def mappings(self):
        return _Mappings(self.rows)


class _Session:
    def __init__(self, rows):
        self.rows = rows
        self.queries = []

    async def execute(self, query, parameters):
        self.queries.append((str(query), parameters))
        return _Result(self.rows)


def test_schema_returns_empty_collections_without_database():
        context = {"repository": GraphQLRepository()}
        context["loaders"] = {"pool": _make_loader(context["repository"], "pool")}
        result = asyncio.run(
                schema.execute(
                        """
                        { pools { id } transactions { id } accounts { id }
                            governanceProposals { id } }
                        """,
                        context_value=context,
                )
        )

        assert result.errors is None


def test_by_ids_batches_one_query_and_preserves_requested_order():
    session = _Session([{"id": "b", "name": "B"}, {"id": "a", "name": "A"}])

    rows = asyncio.run(GraphQLRepository(session).by_ids("pool", ["a", "b", "missing"]))

    assert [row["id"] if row else None for row in rows] == ["a", "b", None]
    assert len(session.queries) == 1


def test_missing_table_falls_back_to_empty_result():
    class MissingTableSession:
        async def execute(self, query, parameters):
            raise RuntimeError("table does not exist")

    rows = asyncio.run(GraphQLRepository(MissingTableSession()).list("account"))

    assert rows == []