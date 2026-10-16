"""Add sampled Soroban event reconciliation audit records."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0012_indexer_audit_logs"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "indexer_audit_logs",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("ledger_sequence", sa.Integer(), nullable=False),
        sa.Column("indexed_event_count", sa.Integer(), nullable=False),
        sa.Column("rpc_event_count", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("details", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column(
            "checked_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "ix_indexer_audit_logs_sequence_checked",
        "indexer_audit_logs",
        ["ledger_sequence", "checked_at"],
    )
    op.create_index("ix_indexer_audit_logs_status", "indexer_audit_logs", ["status"])


def downgrade() -> None:
    op.drop_index("ix_indexer_audit_logs_status", table_name="indexer_audit_logs")
    op.drop_index(
        "ix_indexer_audit_logs_sequence_checked", table_name="indexer_audit_logs"
    )
    op.drop_table("indexer_audit_logs")