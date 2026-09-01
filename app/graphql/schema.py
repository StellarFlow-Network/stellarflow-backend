"""Strawberry schema and FastAPI integration for issue #788."""

from __future__ import annotations

from typing import Any

import strawberry
from strawberry.dataloader import DataLoader
from strawberry.fastapi import GraphQLRouter

from .repository import GraphQLRepository


@strawberry.type
class Pool:
    id: str
    name: str | None = None
    status: str | None = None
    amount: str | None = None


@strawberry.type
class Transaction:
    id: str
    hash: str | None = None
    from_address: str | None = None
    to_address: str | None = None
    type: str | None = None
    status: str | None = None


@strawberry.type
class Account:
    id: str
    address: str | None = None
    name: str | None = None
    status: str | None = None


@strawberry.type
class GovernanceProposal:
    id: str
    title: str | None = None
    description: str | None = None
    proposer: str | None = None
    status: str | None = None
    votes_for: str | None = None
    votes_against: str | None = None


def _make_loader(repository: GraphQLRepository, entity: str) -> DataLoader:
    return DataLoader(load_fn=lambda keys: repository.by_ids(entity, [str(key) for key in keys]))


async def get_context() -> dict[str, Any]:
    return {"repository": GraphQLRepository()}


async def context_getter(request: Any, response: Any) -> dict[str, Any]:
    context = {"repository": GraphQLRepository()}
    context["loaders"] = {
        entity: _make_loader(context["repository"], entity)
        for entity in ("pool", "transaction", "account", "governance_proposal")
    }
    return context


def _convert(model: type, row: dict[str, Any]) -> Any:
    return model(**{field: row.get(field) for field in model.__annotations__})


@strawberry.type
class Query:
    @strawberry.field
    async def pools(self, info: strawberry.Info) -> list[Pool]:
        return [_convert(Pool, row) for row in await info.context["repository"].list("pool")]

    @strawberry.field
    async def pool(self, info: strawberry.Info, id: str) -> Pool | None:
        row = await info.context["loaders"]["pool"].load(id)
        return _convert(Pool, row) if row else None

    @strawberry.field
    async def transactions(self, info: strawberry.Info) -> list[Transaction]:
        return [_convert(Transaction, row) for row in await info.context["repository"].list("transaction")]

    @strawberry.field
    async def transaction(self, info: strawberry.Info, id: str) -> Transaction | None:
        row = await info.context["loaders"]["transaction"].load(id)
        return _convert(Transaction, row) if row else None

    @strawberry.field
    async def accounts(self, info: strawberry.Info) -> list[Account]:
        return [_convert(Account, row) for row in await info.context["repository"].list("account")]

    @strawberry.field
    async def account(self, info: strawberry.Info, id: str) -> Account | None:
        row = await info.context["loaders"]["account"].load(id)
        return _convert(Account, row) if row else None

    @strawberry.field(name="governanceProposals")
    async def governance_proposals(self, info: strawberry.Info) -> list[GovernanceProposal]:
        rows = await info.context["repository"].list("governance_proposal")
        return [_convert(GovernanceProposal, row) for row in rows]

    @strawberry.field
    async def governance_proposal(
        self, info: strawberry.Info, id: str
    ) -> GovernanceProposal | None:
        row = await info.context["loaders"]["governance_proposal"].load(id)
        return _convert(GovernanceProposal, row) if row else None


schema = strawberry.Schema(query=Query)
graphql_app = GraphQLRouter(schema, context_getter=context_getter)