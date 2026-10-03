"""Add encrypted storage columns for private ZK material.

Revision ID: 0009
Revises:     0008

The columns are nullable for rolling deployments and for historical rows that
never contained private proof material. New writers should populate the
envelopes from ``app.security.proof_encryption`` and must not write plaintext
witnesses or tree frontiers to the existing JSON columns.
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

try:
    from sqlalchemy.dialects.postgresql import JSONB
except ImportError:  # pragma: no cover - used only by lightweight migration tests
    JSONB = sa.JSON


revision: str = "0009"
down_revision: Union[str, Sequence[str], None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(table: str, column: str) -> bool:
    bind = op.get_bind()
    if bind is None or getattr(bind, "dialect", None) is None:
        return False
    return any(item["name"] == column for item in sa.inspect(bind).get_columns(table))


def upgrade() -> None:
    """Add nullable envelope columns without rewriting existing public data."""
    additions = {
        "shielded_commitments": "encrypted_proof_inputs",
        "spent_nullifiers": "encrypted_proof_inputs",
        "merkle_roots": "encrypted_tree_state",
    }
    for table, column in additions.items():
        if not _column_exists(table, column):
            op.add_column(
                table,
                sa.Column(
                    column,
                    JSONB,
                    nullable=True,
                    comment="AES-256-GCM envelope; never store plaintext private ZK data",
                ),
            )


def downgrade() -> None:
    """Remove only the new envelope columns."""
    for table, column in (
        ("merkle_roots", "encrypted_tree_state"),
        ("spent_nullifiers", "encrypted_proof_inputs"),
        ("shielded_commitments", "encrypted_proof_inputs"),
    ):
        if _column_exists(table, column):
            op.drop_column(table, column)
