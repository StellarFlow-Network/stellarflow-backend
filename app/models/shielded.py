"""app/models/shielded.py — ORM models for the shielded note indexer.

Three tables support the zero-knowledge privacy layer:

  shielded_commitments  — indexed NoteDeposited Soroban contract events
  spent_nullifiers      — indexed NullifierSpent Soroban contract events
  merkle_roots          — incremental Poseidon-BN254 Merkle tree root history

All models share the ``_PartitionBase`` declarative base defined in
``app/models/events.py``, consistent with every other ORM model in this
application.

Usage::

    from app.models.shielded import ShieldedCommitment, SpentNullifier, MerkleRoot

    commitment = ShieldedCommitment(
        commitment="a1b2c3...",   # 64-char lowercase hex
        leaf_index=0,
        ledger_sequence=42000,
        tx_hash="0xdeadbeef...",
        event_hash="abcd1234...",
    )
    session.add(commitment)
    await session.commit()
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict

from sqlalchemy import (
    DateTime,
    Integer,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.events import _PartitionBase


# ---------------------------------------------------------------------------
# ShieldedCommitment — shielded_commitments table
# ---------------------------------------------------------------------------

class ShieldedCommitment(_PartitionBase):
    """Indexed NoteDeposited Soroban contract event.

    One row per unique commitment note deposited on-chain.  The ``event_hash``
    column mirrors ``LedgerEvent.event_hash`` so that re-processing the same
    source event is idempotent (Requirement 1.3).

    Attributes
    ----------
    id : int
        Auto-incrementing surrogate primary key.
    commitment : str
        64-character lowercase hex representation of the cryptographic
        commitment (32 bytes).  Unique across all rows.
    leaf_index : int
        Zero-based position of this commitment in the ordered Merkle tree.
        Unique across all rows; assigned in strictly ascending order of
        ``(ledger_sequence, event_position)``.
    ledger_sequence : int
        Stellar ledger sequence at which the NoteDeposited event occurred.
    tx_hash : str
        Stellar transaction hash that produced the event.
    event_hash : str
        SHA-256 dedup key sourced from ``LedgerEvent.event_hash``; used for
        idempotent re-processing.
    created_at : datetime
        Wall-clock timestamp of indexer ingestion (TIMESTAMPTZ, defaults to
        ``now()`` at the database server).
    """

    __tablename__ = "shielded_commitments"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
        comment="Auto-incrementing surrogate primary key",
    )

    commitment: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        unique=True,
        index=True,
        comment="64-char lowercase hex commitment (32 bytes), unique per note",
    )

    leaf_index: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        unique=True,
        index=True,
        comment="Zero-based Merkle tree leaf position, strictly ascending",
    )

    ledger_sequence: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        index=True,
        comment="Stellar ledger sequence of the NoteDeposited event",
    )

    tx_hash: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        comment="Stellar transaction hash that produced the event",
    )

    event_hash: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        unique=True,
        index=True,
        comment="LedgerEvent.event_hash — dedup key for idempotent re-processing",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        comment="Indexer ingestion timestamp (TIMESTAMPTZ)",
    )

    __table_args__ = {
        "comment": "Indexed NoteDeposited Soroban contract events",
    }

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<ShieldedCommitment id={self.id} "
            f"commitment={self.commitment[:12]}... "
            f"leaf_index={self.leaf_index} seq={self.ledger_sequence}>"
        )


# ---------------------------------------------------------------------------
# SpentNullifier — spent_nullifiers table
# ---------------------------------------------------------------------------

class SpentNullifier(_PartitionBase):
    """Indexed NullifierSpent Soroban contract event.

    One row per unique nullifier that has been submitted on-chain to mark a
    previously deposited note as spent.  The unique constraint on ``nullifier``
    enforces the double-spend prevention invariant at the database level.

    Attributes
    ----------
    id : int
        Auto-incrementing surrogate primary key.
    nullifier : str
        64-character lowercase hex nullifier value.  Unique across all rows.
    ledger_sequence : int
        Stellar ledger sequence at which the NullifierSpent event occurred.
    tx_hash : str
        Stellar transaction hash that produced the event.
    event_hash : str
        SHA-256 dedup key sourced from ``LedgerEvent.event_hash``; used for
        idempotent re-processing.
    created_at : datetime
        Wall-clock timestamp of indexer ingestion (TIMESTAMPTZ).
    """

    __tablename__ = "spent_nullifiers"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
        comment="Auto-incrementing surrogate primary key",
    )

    nullifier: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        unique=True,
        index=True,
        comment="64-char lowercase hex nullifier (32 bytes), unique per spend",
    )

    ledger_sequence: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        index=True,
        comment="Stellar ledger sequence of the NullifierSpent event",
    )

    tx_hash: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        comment="Stellar transaction hash that produced the event",
    )

    event_hash: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        unique=True,
        index=True,
        comment="LedgerEvent.event_hash — dedup key for idempotent re-processing",
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        comment="Indexer ingestion timestamp (TIMESTAMPTZ)",
    )

    __table_args__ = {
        "comment": "Indexed NullifierSpent Soroban contract events",
    }

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<SpentNullifier id={self.id} "
            f"nullifier={self.nullifier[:12]}... "
            f"seq={self.ledger_sequence}>"
        )


# ---------------------------------------------------------------------------
# MerkleRoot — merkle_roots table
# ---------------------------------------------------------------------------

class MerkleRoot(_PartitionBase):
    """Incremental Poseidon-BN254 Merkle tree root checkpoint.

    One row per ledger sequence at which the Merkle tree was updated.  The
    ``tree_state`` column stores the 20-element frontier array (ordered list
    of right-most path nodes) as a JSON array of 64-char hex strings, enabling
    O(depth) incremental root updates without re-hashing all prior leaves.

    Attributes
    ----------
    id : int
        Auto-incrementing surrogate primary key.
    merkle_root : str
        64-character lowercase hex Merkle root hash.  Indexed for lookups.
    leaf_count : int
        Number of leaves in the tree at this checkpoint.
    ledger_sequence : int
        Stellar ledger sequence at which this root was computed.  Unique —
        at most one root checkpoint per ledger sequence.
    tree_state : dict
        Full 20-level intermediate node array (the incremental tree frontier),
        stored as JSONB.  Not exposed in REST API responses.
    computed_at : datetime
        Wall-clock timestamp at which the root was computed (TIMESTAMPTZ).
    """

    __tablename__ = "merkle_roots"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
        comment="Auto-incrementing surrogate primary key",
    )

    merkle_root: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        index=True,
        comment="64-char lowercase hex Poseidon-BN254 Merkle root",
    )

    leaf_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        comment="Number of leaves in the tree at this checkpoint",
    )

    ledger_sequence: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        unique=True,
        index=True,
        comment="Stellar ledger sequence of this root checkpoint, unique per ledger",
    )

    tree_state: Mapped[Dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        comment=(
            "20-element incremental tree frontier stored as JSONB array of "
            "64-char hex strings; used by MerkleService for O(depth) updates"
        ),
    )

    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        comment="Timestamp at which this root was computed (TIMESTAMPTZ)",
    )

    __table_args__ = {
        "comment": "Incremental Poseidon-BN254 Merkle tree root history",
    }

    def __repr__(self) -> str:  # pragma: no cover
        return (
            f"<MerkleRoot id={self.id} "
            f"root={self.merkle_root[:12]}... "
            f"leaves={self.leaf_count} seq={self.ledger_sequence}>"
        )
