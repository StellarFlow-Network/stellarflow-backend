"""add debt auction tables

Adds debt_auction and debt_auction_bid tables for the automated vault
liquidation debt auction scheduler.

Revision ID: 0011
Revises Previous: 0010
Create Date: 2024-01-01
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "0011"
down_revision = "0010"


def upgrade() -> None:
    op.create_table(
        "debt_auction",
        sa.Column("string(64)", primary_key=True),
        sa.Column("vault_id", sa.String(128), nullable=False),
        sa.Column("liquidation_id", sa.String(128), nullable=False),
        sa.Column("debt_asset", sa.String(16), nullable=False, server_default="'USDC'"),
        sa.Column("collateral_asset", sa.String(16), nullable=False),
        sa.Column("total_debt", sa.Numeric(32, 7), nullable=False),
        sa.Column("remaining_debt", sa.Numeric(32, 7), nullable=False),
        sa.Column("collateral_amount", sa.Numeric(32, 7), nullable=False),
        sa.Column("price_start", sa.Numeric(18, 7), nullable=False),
        sa.Column("decay_k", sa.Numeric(18, 9), nullable=False),
        sa.Column("min_price", sa.Numeric(18, 7), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("auction_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("auction_ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("winning_bid_id", sa.String(64), nullable=True),
        sa.Column("settlement_tx_hash", sa.String(64), nullable=True),
        sa.Column("burned_debt", sa.Numeric(32, 7), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("metadata", JSONB, nullable=True),
        sa.UniqueConstraint("vault_id", "liquidation_id", name="uq_debt_auction_vault_liq"),
    )
    op.create_index("ix_debt_auction_vault_id", "debt_auction", ["vault_id"])
    op.create_index("ix_debt_auction_liquidation_id", "debt_auction", ["liquidation_id"])
    op.create_index("ix_debt_auction_status", "debt_auction", ["status"])
    op.create_index("ix_debt_auction_started_at", "debt_auction", ["auction_started_at"])
    op.create_index("ix_debt_auction_ends_at", "debt_auction", ["auction_ends_at"])
    op.create_index("ix_debt_auction_status_end", "debt_auction", ["status", "auction_ends_at"])

    op.create_table(
        "debt_auction_bid",
        sa.Column("string(64)", primary_key=True),
        sa.Column("auction_id", sa.String(64), sa.ForeignKey("debt_auction.id", ondelete="CASCADE"), nullable=False),
        sa.Column("bidder", sa.String(56), nullable=False),
        sa.Column("debt_offered", sa.Numeric(32, 7), nullable=False),
        sa.Column("collateral_requested", sa.Numeric(32, 7), nullable=False),
        sa.Column("price_at_bid", sa.Numeric(18, 7), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("is_winner", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_debt_auction_bid_auction_id", "debt_auction_bid", ["auction_id"])
    op.create_index("ix_debt_auction_bid_bidder", "debt_auction_bid", ["bidder"])
    op.create_index("ix_debt_auction_bid_status", "debt_auction_bid", ["status"])
    op.create_index("ix_debt_auction_bid_submitted_at", "debt_auction_bid", ["submitted_at"])
    op.create_index("ix_debt_auction_bid_auction_price", "debt_auction_bid", ["auction_id", "price_at_bid"])


def downgrade() -> None:
    op.drop_index("ix_debt_auction_bid_auction_price", table_name="debt_auction_bid")
    op.drop_index("ix_debt_auction_bid_submitted_at", table_name="debt_auction_bid")
    op.drop_index("ix_debt_auction_bid_status", table_name="debt_auction_bid")
    op.drop_index("ix_debt_auction_bid_bidder", table_name="debt_auction_bid")
    op.drop_index("ix_debt_auction_bid_auction_id", table_name="debt_auction_bid")
    op.drop_table("debt_auction_bid")

    op.drop_index("ix_debt_auction_status_end", table_name="debt_auction")
    op.drop_index("ix_debt_auction_ends_at", table_name="debt_auction")
    op.drop_index("ix_debt_auction_started_at", table_name="debt_auction")
    op.drop_index("ix_debt_auction_status", table_name="debt_auction")
    op.drop_index("ix_debt_auction_liquidation_id", table_name="debt_auction")
    op.drop_index("ix_debt_auction_vault_id", table_name="debt_auction")
    op.drop_table("debt_auction")
