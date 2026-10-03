"""Add protocol treasury yield sweeper tables

Revision ID: 0009_add_treasury_yield_sweeper
Revises: 0008_add_treasury_yield_worker
Create Date: 2026-10-01 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision = '0009_add_treasury_yield_sweeper'
down_revision = '0008_add_treasury_yield_worker'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'treasury_yield_sweep',
        sa.Column('id', sa.String(length=64), nullable=False, comment='SHA-256(strategy_id:timestamp)'),
        sa.Column('strategy_id', sa.String(length=128), nullable=False, comment='Reference to vault_strategy.id'),
        sa.Column('vault_address', sa.String(length=56), nullable=False, comment='On-chain vault contract address'),
        sa.Column('reward_asset', sa.String(length=16), server_default=sa.text("'USDC'"), nullable=False, comment='Reward asset ticker'),
        sa.Column('uncollected_amount', sa.Numeric(precision=32, scale=7), nullable=False, comment='Uncollected staking rewards amount'),
        sa.Column('reward_asset_price_usd', sa.Numeric(precision=18, scale=7), server_default=sa.text('1.0'), nullable=False, comment='Reward asset price in USD'),
        sa.Column('uncollected_usd_value', sa.Numeric(precision=18, scale=7), nullable=False, comment='Total uncollected rewards in USD value'),
        sa.Column('claim_threshold_usd', sa.Numeric(precision=18, scale=7), server_default=sa.text('500.0'), nullable=False, comment='Claim threshold in USD ($500)'),
        sa.Column('status', sa.String(length=16), nullable=False, comment='Sweep status (SKIPPED, CLAIMED, ROUTED, FAILED)'),
        sa.Column('claim_transaction_hash', sa.String(length=64), nullable=True, comment='Transaction hash for claim_treasury_rewards'),
        sa.Column('route_transaction_hash', sa.String(length=64), nullable=True, comment='Transaction hash for routing to reserve liquidity pool'),
        sa.Column('liquidity_pool_id', sa.String(length=128), nullable=True, comment='Target protocol reserve liquidity pool identifier'),
        sa.Column('routed_amount', sa.Numeric(precision=32, scale=7), nullable=True, comment='Amount of claimed yield routed to reserve liquidity pool'),
        sa.Column('evaluated_at', sa.DateTime(timezone=True), nullable=False, comment='Timestamp when uncollected rewards were evaluated'),
        sa.Column('claimed_at', sa.DateTime(timezone=True), nullable=True, comment='Timestamp when rewards were claimed'),
        sa.Column('routed_at', sa.DateTime(timezone=True), nullable=True, comment='Timestamp when yield was routed to reserve liquidity pool'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False, comment='Record creation timestamp'),
        sa.Column('metadata', JSONB(astext_type=sa.Text()), nullable=True, comment='Additional sweep metadata'),
        sa.PrimaryKeyConstraint('id'),
        comment='Audit trail of treasury staked asset yield sweep operations'
    )

    op.create_index('ix_treasury_yield_sweep_strategy_id', 'treasury_yield_sweep', ['strategy_id'])
    op.create_index('ix_treasury_yield_sweep_status', 'treasury_yield_sweep', ['status'])
    op.create_index('ix_treasury_yield_sweep_evaluated_at', 'treasury_yield_sweep', ['evaluated_at'])
    op.create_index('ix_treasury_sweep_status_time', 'treasury_yield_sweep', ['status', 'evaluated_at'])
    op.create_index('ix_treasury_sweep_strategy_time', 'treasury_yield_sweep', ['strategy_id', 'evaluated_at'])


def downgrade() -> None:
    op.drop_index('ix_treasury_sweep_strategy_time', table_name='treasury_yield_sweep')
    op.drop_index('ix_treasury_sweep_status_time', table_name='treasury_yield_sweep')
    op.drop_index('ix_treasury_yield_sweep_evaluated_at', table_name='treasury_yield_sweep')
    op.drop_index('ix_treasury_yield_sweep_status', table_name='treasury_yield_sweep')
    op.drop_index('ix_treasury_yield_sweep_strategy_id', table_name='treasury_yield_sweep')
    op.drop_table('treasury_yield_sweep')
