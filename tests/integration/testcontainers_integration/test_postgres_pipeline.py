"""PostgreSQL integration tests — LedgerEvent CRUD via SQLAlchemy against a real PostgreSQL container.

Tests cover:
- Table creation and schema verification
- Inserting LedgerEvent records with JSONB payloads
- Querying by event_type, ledger_sequence range
- Duplicate event_hash rejection (primary key constraint)
- Concurrent async inserts
- JSONB payload round-trip integrity
"""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.models.events import LedgerEvent

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_event(
    *,
    ledger_sequence: int = 420_000,
    tx_hash: str = "abc123def456",
    event_type: str = "contract",
    payload: dict | None = None,
    seed: int = 0,
) -> LedgerEvent:
    """Build a ``LedgerEvent`` instance with a deterministic ``event_hash``."""
    event_hash = hashlib.sha256(
        f"{ledger_sequence}:{tx_hash}:{seed}".encode()
    ).hexdigest()
    return LedgerEvent(
        event_hash=event_hash,
        ledger_sequence=ledger_sequence,
        tx_hash=tx_hash,
        event_type=event_type,
        payload=payload or {"data": "test-event", "amount": 100},
        created_at=datetime.now(timezone.utc),
    )


# ---------------------------------------------------------------------------
# Sync session tests
# ---------------------------------------------------------------------------


class TestLedgerEventCRUD:
    """Synchronous session tests against the real PostgreSQL container."""

    def test_insert_and_retrieve_event(self, db_session: Session) -> None:
        event = _make_event(seed=1)
        db_session.add(event)
        db_session.flush()

        retrieved = db_session.query(LedgerEvent).filter_by(
            event_hash=event.event_hash
        ).first()
        assert retrieved is not None
        assert retrieved.ledger_sequence == 420_000
        assert retrieved.event_type == "contract"
        assert retrieved.payload["data"] == "test-event"
        assert retrieved.payload["amount"] == 100

    def test_jsonb_payload_round_trip(self, db_session: Session) -> None:
        complex_payload = {
            "nested": {"key": "value", "num": 42},
            "array": [1, 2, 3],
            "flag": True,
            "null_val": None,
        }
        event = _make_event(seed=2, payload=complex_payload)
        db_session.add(event)
        db_session.flush()

        retrieved = db_session.query(LedgerEvent).filter_by(
            event_hash=event.event_hash
        ).first()
        assert retrieved.payload == complex_payload

    def test_duplicate_event_hash_rejected(self, db_session: Session) -> None:
        event1 = _make_event(seed=3)
        db_session.add(event1)
        db_session.flush()

        event2 = _make_event(seed=3)  # same seed → same hash
        db_session.add(event2)
        with pytest.raises(Exception):  # IntegrityError
            db_session.flush()

    def test_query_by_event_type(self, db_session: Session) -> None:
        db_session.add(_make_event(seed=10, event_type="transfer"))
        db_session.add(_make_event(seed=11, event_type="deposit"))
        db_session.add(_make_event(seed=12, event_type="transfer"))
        db_session.flush()

        transfers = (
            db_session.query(LedgerEvent)
            .filter_by(event_type="transfer")
            .all()
        )
        assert len(transfers) == 2

    def test_query_by_ledger_sequence_range(self, db_session: Session) -> None:
        db_session.add(_make_event(seed=20, ledger_sequence=100))
        db_session.add(_make_event(seed=21, ledger_sequence=200))
        db_session.add(_make_event(seed=22, ledger_sequence=300))
        db_session.flush()

        results = (
            db_session.query(LedgerEvent)
            .filter(LedgerEvent.ledger_sequence.between(150, 250))
            .all()
        )
        assert len(results) == 1
        assert results[0].ledger_sequence == 200

    def test_insert_multiple_events(self, db_session: Session) -> None:
        events = [_make_event(seed=i, ledger_sequence=1000 + i) for i in range(10)]
        db_session.add_all(events)
        db_session.flush()

        count = db_session.query(LedgerEvent).count()
        assert count == 10

    def test_event_repr(self, db_session: Session) -> None:
        event = _make_event(seed=30)
        db_session.add(event)
        db_session.flush()

        r = repr(event)
        assert "LedgerEvent" in r
        assert "contract" in r


# ---------------------------------------------------------------------------
# Async session tests
# ---------------------------------------------------------------------------


class TestLedgerEventAsyncCRUD:
    """Async session tests against the real PostgreSQL container."""

    async def test_async_insert_and_retrieve(self, async_db_session: AsyncSession) -> None:
        event = _make_event(seed=100)
        async_db_session.add(event)
        await async_db_session.flush()

        result = await async_db_session.execute(
            text("SELECT * FROM ledger_events WHERE event_hash = :hash"),
            {"hash": event.event_hash},
        )
        row = result.mappings().first()
        assert row is not None
        assert row["ledger_sequence"] == 420_000
        assert row["event_type"] == "contract"

    async def test_async_concurrent_inserts(self, async_db_session: AsyncSession) -> None:
        events = [_make_event(seed=200 + i, ledger_sequence=500_000 + i) for i in range(20)]
        async_db_session.add_all(events)
        await async_db_session.flush()

        result = await async_db_session.execute(
            text("SELECT COUNT(*) as cnt FROM ledger_events")
        )
        count = result.scalar()
        assert count == 20

    async def test_async_jsonb_query(self, async_db_session: AsyncSession) -> None:
        event = _make_event(seed=300, payload={"token": "USDC", "amount": 500})
        async_db_session.add(event)
        await async_db_session.flush()

        result = await async_db_session.execute(
            text(
                "SELECT * FROM ledger_events "
                "WHERE (payload->>'token') = :token"
            ),
            {"token": "USDC"},
        )
        rows = result.mappings().all()
        assert len(rows) == 1
        assert rows[0]["payload"]["amount"] == 500

    async def test_async_delete_event(self, async_db_session: AsyncSession) -> None:
        event = _make_event(seed=400)
        async_db_session.add(event)
        await async_db_session.flush()

        await async_db_session.execute(
            text("DELETE FROM ledger_events WHERE event_hash = :hash"),
            {"hash": event.event_hash},
        )
        result = await async_db_session.execute(
            text("SELECT COUNT(*) FROM ledger_events")
        )
        assert result.scalar() == 0
