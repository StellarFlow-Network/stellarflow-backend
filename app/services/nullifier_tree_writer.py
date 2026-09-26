"""Lock-protected nullifier/tree write orchestration.

Adapt the repository-specific insert and Merkle-root operations in
`write_operation` before production use.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TypeVar

from sqlalchemy.ext.asyncio import AsyncSession
import redis.asyncio as redis

from app.services.nullifier_lock import NullifierTreeLock

T = TypeVar("T")


class NullifierTreeWriter:
    def __init__(
        self,
        redis_client: redis.Redis,
        session: AsyncSession,
        tree_id: str = "spent-nullifiers",
    ) -> None:
        self.redis_client = redis_client
        self.session = session
        self.tree_id = tree_id

    async def write_atomically(
        self,
        write_operation: Callable[[AsyncSession], Awaitable[T]],
    ) -> T:
        """Serialize tree writes and commit one database transaction.

        The callback must perform the nullifier insertion and Merkle-root
        update using the supplied session. It must not commit independently.
        """
        async with NullifierTreeLock(self.redis_client, self.tree_id):
            try:
                async with self.session.begin():
                    result = await write_operation(self.session)
                return result
            except Exception:
                # The session transaction is rolled back by SQLAlchemy's
                # context manager. The Redis lock is released by __aexit__.
                raise
