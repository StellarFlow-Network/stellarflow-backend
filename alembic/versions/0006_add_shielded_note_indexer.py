"""Add shielded note indexer tables for ZK private transactions.

Revision ID: 0006
Revises:     0005
Create Date: 2026-09-02 00:00:00.000000 UTC

Creates the ``shielded_commitments``, ``spent_nullifiers``, and ``merkle_roots``
tables supporting the zero-knowledge shielded transaction indexing layer.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
try:
    from sqlalchemy.dialects.postgresql import JSONB
except ImportError:
    JSONB = sa.JSON

# ---------------------------------------------------------------------------
# Revision identifiers
# ---------------------------------------------------------------------------
revision: str = "0006"
down_revision: Union[str, Sequence[str], None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _table_exists(name: str) -> bool:
    """Return True when *name* already exists in the public schema."""
    bind = op.get_bind()
    if bind is None or getattr(bind, "dialect", None) is None:
        return False
    try:
        return sa.inspect(bind).has_table(name)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# upgrade
# ---------------------------------------------------------------------------

def upgrade() -> None:
    """Create shielded_commitments, spent_nullifiers, and merkle_roots tables."""

    # 1. shielded_commitments table
    if not _table_exists("shielded_commitments"):
        op.create_table(
            "shielded_commitments",
            sa.Column(
                "id",
                sa.Integer(),
                primary_key=True,
                autoincrement=True,
                nullable=False,
                comment="Auto-incrementing surrogate primary key",
            ),
            sa.Column(
                "commitment",
                sa.String(64),
                nullable=False,
                comment="64-char lowercase hex commitment (32 bytes), unique per note",
            ),
            sa.Column(
                "leaf_index",
                sa.Integer(),
                nullable=False,
                comment="Zero-based Merkle tree leaf position, strictly ascending",
            ),
            sa.Column(
                "ledger_sequence",
                sa.Integer(),
                nullable=False,
                comment="Stellar ledger sequence of the NoteDeposited event",
            ),
            sa.Column(
                "tx_hash",
                sa.String(128),
                nullable=False,
                comment="Stellar transaction hash that produced the event",
            ),
            sa.Column(
                "event_hash",
                sa.String(64),
                nullable=False,
                comment="LedgerEvent.event_hash — dedup key for idempotent re-processing",
            ),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
                comment="Indexer ingestion timestamp (TIMESTAMPTZ)",
            ),
            comment="Indexed NoteDeposited Soroban contract events",
        )

        op.create_index(
            "ix_shielded_commitments_commitment",
            "shielded_commitments",
            ["commitment"],
            unique=True,
        )
        op.create_index(
            "ix_shielded_commitments_leaf_index",
            "shielded_commitments",
            ["leaf_index"],
            unique=True,
        )
        op.create_index(
            "ix_shielded_commitments_ledger_sequence",
            "shielded_commitments",
            ["ledger_sequence"],
        )
        op.create_index(
            "ix_shielded_commitments_event_hash",
            "shielded_commitments",
            ["event_hash"],
            unique=True,
        )

    # 2. spent_nullifiers table
    if not _table_exists("spent_nullifiers"):
        op.create_table(
            "spent_nullifiers",
            sa.Column(
                "id",
                sa.Integer(),
                primary_key=True,
                autoincrement=True,
                nullable=False,
                comment="Auto-incrementing surrogate primary key",
            ),
            sa.Column(
                "nullifier",
                sa.String(64),
                nullable=False,
                comment="64-char lowercase hex nullifier (32 bytes), unique per spend",
            ),
            sa.Column(
                "ledger_sequence",
                sa.Integer(),
                nullable=False,
                comment="Stellar ledger sequence of the NullifierSpent event",
            ),
            sa.Column(
                "tx_hash",
                sa.String(128),
                nullable=False,
                comment="Stellar transaction hash that produced the event",
            ),
            sa.Column(
                "event_hash",
                sa.String(64),
                nullable=False,
                comment="LedgerEvent.event_hash — dedup key for idempotent re-processing",
            ),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
                comment="Indexer ingestion timestamp (TIMESTAMPTZ)",
            ),
            comment="Indexed NullifierSpent Soroban contract events",
        )

        op.create_index(
            "ix_spent_nullifiers_nullifier",
            "spent_nullifiers",
            ["nullifier"],
            unique=True,
        )
        op.create_index(
            "ix_spent_nullifiers_ledger_sequence",
            "spent_nullifiers",
            ["ledger_sequence"],
        )
        op.create_index(
            "ix_spent_nullifiers_event_hash",
            "spent_nullifiers",
            ["event_hash"],
            unique=True,
        )

    # 3. merkle_roots table
    if not _table_exists("merkle_roots"):
        op.create_table(
            "merkle_roots",
            sa.Column(
                "id",
                sa.Integer(),
                primary_key=True,
                autoincrement=True,
                nullable=False,
                comment="Auto-incrementing surrogate primary key",
            ),
            sa.Column(
                "merkle_root",
                sa.String(64),
                nullable=False,
                comment="64-char lowercase hex Poseidon-BN254 Merkle root",
            ),
            sa.Column(
                "leaf_count",
                sa.Integer(),
                nullable=False,
                comment="Number of leaves in the tree at this checkpoint",
            ),
            sa.Column(
                "ledger_sequence",
                sa.Integer(),
                nullable=False,
                comment="Stellar ledger sequence of this root checkpoint, unique per ledger",
            ),
            sa.Column(
                "tree_state",
                JSONB,
                nullable=False,
                comment="20-element incremental tree frontier stored as JSONB array",
            ),
            sa.Column(
                "computed_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
                comment="Timestamp at which this root was computed (TIMESTAMPTZ)",
            ),
            comment="Incremental Poseidon-BN254 Merkle tree root history",
        )

        op.create_index(
            "ix_merkle_roots_merkle_root",
            "merkle_roots",
            ["merkle_root"],
        )
        op.create_index(
            "ix_merkle_roots_ledger_sequence",
            "merkle_roots",
            ["ledger_sequence"],
            unique=True,
        )


# ---------------------------------------------------------------------------
# downgrade
# ---------------------------------------------------------------------------

def downgrade() -> None:
    """Drop merkle_roots, spent_nullifiers, and shielded_commitments tables."""

    if _table_exists("merkle_roots"):
        op.drop_table("merkle_roots")

    if _table_exists("spent_nullifiers"):
        op.drop_table("spent_nullifiers")

    if _table_exists("shielded_commitments"):
        op.drop_table("shielded_commitments")
