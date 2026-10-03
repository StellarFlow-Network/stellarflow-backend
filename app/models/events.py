"""app/models/events.py — LedgerEvent ORM model for PostgreSQL range-partitioned storage.

The ``LedgerEvent`` table is the ingestion target for Stellar Soroban
blockchain events (see ``src/ingestion/soroban_listener.py``).  It is
defined as a PostgreSQL **declaratively partitioned** parent table using
RANGE partitioning on ``created_at`` (month/year boundaries).

Monthly child partitions are created automatically by the partition manager
(``src/database/partition_manager.py``).

Usage::

    from app.models.events import LedgerEvent

    event = LedgerEvent(
        event_hash="abc123...",
        ledger_sequence=42000,
        tx_hash="0xdeadbeef",
        event_type="contract",
        payload={"data": "..."},
    )
    session.add(event)
    await session.commit()
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import (
    DateTime,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base as _PartitionBase


class LedgerEvent(_PartitionBase):
    """Stellar Soroban ledger event — stored in the ``ledger_events`` table.

    The parent table is a PostgreSQL partitioned table (RANGE on
    ``created_at``).  Individual rows live in monthly child tables
    (e.g. ``ledger_events_2026_01``).

    Attributes
    ----------
    event_hash : str
        SHA-256 of ``"{ledger_seq}:{tx_hash}:{event_index}"`` — used as
        the unique constraint for deduplication.
    ledger_sequence : int
        Stellar ledger sequence number at the time of the event.
    tx_hash : str
        Stellar transaction hash that produced the event.
    event_type : str
        Event topic / classification (e.g. ``contract``, ``payment``).
    payload : dict
        Full JSON event payload from the Soroban RPC stream.
    created_at : datetime
        Wall-clock timestamp — the partition key.  PostgreSQL routes rows
        to the correct child table based on this value.
    """

    __tablename__ = "ledger_events"

    # -- Columns ----------------------------------------------------------

    event_hash: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        comment="SHA-256(ledger_seq:tx_hash:event_index)",
    )

    ledger_sequence: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        index=True,
        comment="Stellar ledger sequence number",
    )

    tx_hash: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        index=True,
        comment="Stellar transaction hash",
    )

    event_type: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        server_default="unknown",
        index=True,
        comment="Event topic / classification",
    )

    payload: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSONB,
        nullable=True,
        comment="Full Soroban event payload",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        index=True,
        comment="Event timestamp — partition key",
    )

    # -- Table args for partitioning --------------------------------------

    __table_args__ = {
        "comment": "Stellar Soroban ledger events — range-partitioned by created_at (monthly)",
    }

    def __repr__(self) -> str:
        return (
            f"<LedgerEvent hash={self.event_hash[:12]}... "
            f"seq={self.ledger_sequence} type={self.event_type}>"
        )
