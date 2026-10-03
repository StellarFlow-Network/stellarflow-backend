"""Add s3_cleanup_run_log table for Issue #979 S3 export cleaner worker.

Revision ID: 0009_add_s3_cleanup_run_log
Revises: 0008_add_treasury_yield_worker
Create Date: 2026-09-28 02:00:00.000000 UTC

Each row records the outcome of a single ``purge_s3_temp_exports`` Celery
task run so that operators can audit storage reclaimed over time and detect
regressions (e.g. a run that deleted zero objects when thousands were expected).
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# ---------------------------------------------------------------------------
# Revision identifiers
# ---------------------------------------------------------------------------
revision: str = "0009_add_s3_cleanup_run_log"
down_revision: Union[str, Sequence[str], None] = "0008_add_treasury_yield_worker"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create the ``s3_cleanup_run_log`` table."""
    op.create_table(
        "s3_cleanup_run_log",
        sa.Column(
            "id",
            sa.String(length=64),
            nullable=False,
            comment="SHA-256(bucket:started_at ISO)",
        ),
        sa.Column(
            "bucket",
            sa.String(length=255),
            nullable=False,
            comment="S3 bucket that was scanned",
        ),
        sa.Column(
            "prefix",
            sa.String(length=255),
            nullable=True,
            comment="Optional key prefix filter applied during the scan",
        ),
        sa.Column(
            "ttl_hours",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("24"),
            comment="Age threshold in hours used for this run",
        ),
        sa.Column(
            "dry_run",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
            comment="True when the run logged but did not delete any objects",
        ),
        sa.Column(
            "objects_scanned",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
            comment="Total number of objects listed in the bucket",
        ),
        sa.Column(
            "objects_deleted",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
            comment="Number of stale objects that were deleted (or would be in dry-run)",
        ),
        sa.Column(
            "bytes_reclaimed",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
            comment="Total bytes freed (or would-be freed in dry-run)",
        ),
        sa.Column(
            "error_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
            comment="Number of per-key delete errors reported by S3",
        ),
        sa.Column(
            "duration_ms",
            sa.Numeric(precision=10, scale=2),
            nullable=True,
            comment="Wall-clock duration of the cleanup run in milliseconds",
        ),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            comment="UTC timestamp when the task started",
        ),
        sa.Column(
            "completed_at",
            sa.DateTime(timezone=True),
            nullable=False,
            comment="UTC timestamp when the task finished",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
            comment="Row insertion timestamp",
        ),
        sa.PrimaryKeyConstraint("id"),
        comment="Audit log for each S3 temporary-export cleanup run (Issue #979)",
    )

    op.create_index(
        "ix_s3_cleanup_run_log_started_at",
        "s3_cleanup_run_log",
        ["started_at"],
    )
    op.create_index(
        "ix_s3_cleanup_run_log_bucket_started",
        "s3_cleanup_run_log",
        ["bucket", "started_at"],
    )
    op.create_index(
        "ix_s3_cleanup_run_log_created_at",
        "s3_cleanup_run_log",
        ["created_at"],
    )


def downgrade() -> None:
    """Drop the ``s3_cleanup_run_log`` table and its indexes."""
    op.drop_index(
        "ix_s3_cleanup_run_log_created_at",
        table_name="s3_cleanup_run_log",
    )
    op.drop_index(
        "ix_s3_cleanup_run_log_bucket_started",
        table_name="s3_cleanup_run_log",
    )
    op.drop_index(
        "ix_s3_cleanup_run_log_started_at",
        table_name="s3_cleanup_run_log",
    )
    op.drop_table("s3_cleanup_run_log")
