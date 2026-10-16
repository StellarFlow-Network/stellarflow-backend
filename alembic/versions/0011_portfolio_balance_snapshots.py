"""Add daily wallet token balance snapshots for portfolio history."""

from alembic import op
import sqlalchemy as sa


revision = "0011_portfolio_balance_snapshots"
down_revision = "0009_add_wallet_aggregation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "portfolio_balance_snapshot",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("wallet_group_id", sa.String(length=64), nullable=False),
        sa.Column("public_key", sa.String(length=56), nullable=False),
        sa.Column("asset_key", sa.String(length=128), nullable=False),
        sa.Column("asset_code", sa.String(length=32), nullable=False),
        sa.Column("asset_issuer", sa.String(length=56), nullable=True),
        sa.Column("balance", sa.Numeric(38, 18), nullable=False),
        sa.Column("twap_usd", sa.Numeric(38, 18), nullable=False),
        sa.Column("snapshot_date", sa.Date(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["wallet_group_id"], ["wallet_group.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "wallet_group_id",
            "public_key",
            "asset_key",
            "snapshot_date",
            name="uq_portfolio_balance_snapshot_daily_asset",
        ),
    )
    op.create_index(
        "ix_portfolio_balance_snapshot_group_date",
        "portfolio_balance_snapshot",
        ["wallet_group_id", "snapshot_date"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_portfolio_balance_snapshot_group_date",
        table_name="portfolio_balance_snapshot",
    )
    op.drop_table("portfolio_balance_snapshot")