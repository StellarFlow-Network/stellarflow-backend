"""Add protocol treasury yield auto-staking tables

Revision ID: 0008_add_treasury_yield_worker
Revises: 0007_add_capital_allocation_rebalancing
Create Date: 2026-10-01 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision = '0008_add_treasury_yield_worker'
down_revision = '0007_add_capital_allocation_rebalancing'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create treasury_yield_allocation table
    op.create_table(
        'treasury_yield_allocation',
        sa.Column('id', sa.String(length=64), nullable=False, comment='SHA-256(strategy_id:window_start)'),
        sa.Column('strategy_id', sa.String(length=128), nullable=False, comment='Reference to vault_strategy.id'),
        sa.Column('vault_address', sa.String(length=56), nullable=False, comment='On-chain vault contract address'),
        sa.Column('amount', sa.Numeric(precision=32, scale=7), nullable=False, comment='USDC amount staked into the vault'),
        sa.Column('apy', sa.Numeric(precision=10, scale=7), nullable=False, comment='Expected APY at allocation time (fractional)'),
        sa.Column('status', sa.String(length=16), nullable=False, comment='Allocation status (PENDING, STAKED, FAILED, UNSTAKED)'),
        sa.Column('transaction_hash', sa.String(length=64), nullable=True, comment='On-chain staking transaction hash'),
        sa.Column('window_start', sa.DateTime(timezone=True), nullable=False, comment='Allocation window start (UTC)'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False, comment='Record creation timestamp'),
        sa.Column('metadata', JSONB(astext_type=sa.Text()), nullable=True, comment='Additional execution context'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('strategy_id', 'window_start', name='uq_treasury_allocation_window'),
        comment='Staking allocations of idle treasury USDC into yield vaults'
    )

    op.create_index('ix_treasury_yield_allocation_strategy_id', 'treasury_yield_allocation', ['strategy_id'])
    op.create_index('ix_treasury_yield_allocation_status', 'treasury_yield_allocation', ['status'])
    op.create_index('ix_treasury_yield_allocation_window_start', 'treasury_yield_allocation', ['window_start'])
    op.create_index('ix_treasury_allocation_status_window', 'treasury_yield_allocation', ['status', 'window_start'])

    # Create treasury_yield_report table
    op.create_table(
        'treasury_yield_report',
        sa.Column('id', sa.String(length=64), nullable=False, comment='SHA-256(period_start)'),
        sa.Column('period_start', sa.DateTime(timezone=True), nullable=False, comment='Reporting period start (UTC)'),
        sa.Column('period_end', sa.DateTime(timezone=True), nullable=False, comment='Reporting period end (UTC)'),
        sa.Column('total_staked', sa.Numeric(precision=32, scale=7), nullable=False, comment='Total USDC staked during the period'),
        sa.Column('total_yield_earned', sa.Numeric(precision=32, scale=7), nullable=False, comment='Total USDC yield earned during the period'),
        sa.Column('average_apy', sa.Numeric(precision=10, scale=7), nullable=False, comment='Weighted average APY (fractional)'),
        sa.Column('liquid_reserve', sa.Numeric(precision=32, scale=7), nullable=False, comment='Liquid reserve balance at period close'),
        sa.Column('reserve_ratio', sa.Numeric(precision=5, scale=4), nullable=False, comment='Liquid reserve fraction of total treasury balance'),
        sa.Column('allocation_count', sa.Integer(), server_default=sa.text('0'), nullable=False, comment='Number of staking allocations in the period'),
        sa.Column('summary', JSONB(astext_type=sa.Text()), nullable=True, comment='Structured per-strategy breakdown for governance'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False, comment='Record creation timestamp'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('period_start', name='uq_treasury_report_period'),
        comment='Monthly yield generation summaries for governance'
    )

    op.create_index('ix_treasury_yield_report_period_start', 'treasury_yield_report', ['period_start'])
    op.create_index('ix_treasury_report_period', 'treasury_yield_report', ['period_start', 'period_end'])


def downgrade() -> None:
    op.drop_index('ix_treasury_report_period', table_name='treasury_yield_report')
    op.drop_index('ix_treasury_yield_report_period_start', table_name='treasury_yield_report')
    op.drop_table('treasury_yield_report')

    op.drop_index('ix_treasury_allocation_status_window', table_name='treasury_yield_allocation')
    op.drop_index('ix_treasury_yield_allocation_window_start', table_name='treasury_yield_allocation')
    op.drop_index('ix_treasury_yield_allocation_status', table_name='treasury_yield_allocation')
    op.drop_index('ix_treasury_yield_allocation_strategy_id', table_name='treasury_yield_allocation')
    op.drop_table('treasury_yield_allocation')
