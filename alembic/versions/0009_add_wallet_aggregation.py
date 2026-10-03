"""Add multi-address wallet aggregation tables

Revision ID: 0009_add_wallet_aggregation
Revises: 0008_add_treasury_yield_worker
Create Date: 2026-09-30 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision = '0009_add_wallet_aggregation'
down_revision = '0008_add_treasury_yield_worker'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create wallet_group table
    op.create_table(
        'wallet_group',
        sa.Column('id', sa.String(length=64), nullable=False, comment='Unique wallet group identifier'),
        sa.Column('user_id', sa.Integer(), nullable=False, comment='Reference to Relayer (user) who owns this group'),
        sa.Column('name', sa.String(length=128), nullable=False, comment='Human-readable name for the wallet group'),
        sa.Column('description', sa.Text(), nullable=True, comment='Optional description of the wallet group'),
        sa.Column('is_default', sa.Boolean(), nullable=False, server_default=sa.text('false'), comment='Whether this is the user\'s default wallet group'),
        sa.Column('metadata', JSONB(astext_type=sa.Text()), nullable=True, comment='Additional group configuration'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False, comment='Group creation timestamp'),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False, comment='Last update timestamp'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'name', name='uq_wallet_group_user_name'),
        comment='User-defined wallet groups for unified portfolio view'
    )

    op.create_index('ix_wallet_group_user_id', 'wallet_group', ['user_id'])
    op.create_index('ix_wallet_group_user_default', 'wallet_group', ['user_id', 'is_default'])

    # Create wallet_group_member table
    op.create_table(
        'wallet_group_member',
        sa.Column('id', sa.String(length=64), nullable=False, comment='Unique member identifier'),
        sa.Column('wallet_group_id', sa.String(length=64), nullable=False, comment='Reference to parent wallet group'),
        sa.Column('public_key', sa.String(length=56), nullable=False, comment='Stellar public key (G-prefixed)'),
        sa.Column('label', sa.String(length=128), nullable=True, comment='Optional label for this wallet'),
        sa.Column('is_primary', sa.Boolean(), nullable=False, server_default=sa.text('false'), comment='Whether this is the primary wallet in the group'),
        sa.Column('metadata', JSONB(astext_type=sa.Text()), nullable=True, comment='Additional member configuration'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False, comment='Member addition timestamp'),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False, comment='Last update timestamp'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('wallet_group_id', 'public_key', name='uq_wallet_group_member_group_key'),
        comment='Stellar public key members of wallet groups'
    )

    op.create_index('ix_wallet_group_member_wallet_group_id', 'wallet_group_member', ['wallet_group_id'])
    op.create_index('ix_wallet_group_member_public_key', 'wallet_group_member', ['public_key'])


def downgrade() -> None:
    op.drop_index('ix_wallet_group_member_public_key', table_name='wallet_group_member')
    op.drop_index('ix_wallet_group_member_wallet_group_id', table_name='wallet_group_member')
    op.drop_table('wallet_group_member')

    op.drop_index('ix_wallet_group_user_default', table_name='wallet_group')
    op.drop_index('ix_wallet_group_user_id', table_name='wallet_group')
    op.drop_table('wallet_group')
