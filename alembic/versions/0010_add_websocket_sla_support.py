"""Add WebSocket SLA monitoring support to endpoint_sla_metrics

Revision ID: 0010_add_websocket_sla_support
Revises: 0009_add_endpoint_sla_monitoring
Create Date: 2026-09-29 12:00:00.000000

Issue #973 — Build Automated API Endpoint Performance SLA Monitoring Middleware

This migration extends the endpoint_sla_metrics table to support WebSocket
endpoints in addition to HTTP/REST endpoints. WebSocket-specific fields include:
- endpoint_type: Distinguishes 'http' vs 'websocket' entries
- websocket_action: Action type (subscribe, unsubscribe, message, etc.)
- websocket_channel: Channel/topic name for pub/sub systems
- total_connections: Number of WebSocket connections in the window
- avg_connection_duration_seconds: Average connection lifetime

The unique constraint is updated to accommodate both HTTP and WebSocket routes.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '0010_add_websocket_sla_support'
down_revision = '0009_add_endpoint_sla_monitoring'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add endpoint_type column (default to 'http' for existing rows)
    op.add_column(
        'endpoint_sla_metrics',
        sa.Column(
            'endpoint_type',
            sa.String(length=16),
            nullable=False,
            server_default='http',
            comment="Endpoint type: 'http' or 'websocket'"
        )
    )
    
    # Add WebSocket-specific columns
    op.add_column(
        'endpoint_sla_metrics',
        sa.Column(
            'websocket_action',
            sa.String(length=64),
            nullable=True,
            comment="WebSocket action type (e.g., 'subscribe', 'unsubscribe', 'message') - NULL for HTTP"
        )
    )
    
    op.add_column(
        'endpoint_sla_metrics',
        sa.Column(
            'websocket_channel',
            sa.String(length=256),
            nullable=True,
            comment="WebSocket channel/topic name - NULL for HTTP"
        )
    )
    
    op.add_column(
        'endpoint_sla_metrics',
        sa.Column(
            'total_connections',
            sa.BigInteger(),
            nullable=True,
            comment="Total WebSocket connections in this window - NULL for HTTP"
        )
    )
    
    op.add_column(
        'endpoint_sla_metrics',
        sa.Column(
            'avg_connection_duration_seconds',
            sa.Float(),
            nullable=True,
            comment="Average WebSocket connection duration in seconds - NULL for HTTP"
        )
    )
    
    # Make http_method nullable (since WebSocket endpoints don't have HTTP methods)
    op.alter_column(
        'endpoint_sla_metrics',
        'http_method',
        existing_type=sa.String(length=10),
        nullable=True,
        comment="HTTP method (GET, POST, PUT, DELETE, PATCH, etc.) - NULL for WebSocket"
    )
    
    # Update route_path comment to include WebSocket paths
    op.alter_column(
        'endpoint_sla_metrics',
        'route_path',
        existing_type=sa.String(length=512),
        comment="URL path pattern (e.g., /api/v1/users/{id} or /ws/live)"
    )
    
    # Drop the old unique constraint
    op.drop_constraint('uq_endpoint_sla_window', 'endpoint_sla_metrics', type_='unique')
    
    # Create new unique constraint that supports both HTTP and WebSocket
    op.create_unique_constraint(
        'uq_endpoint_sla_window',
        'endpoint_sla_metrics',
        ['window_start', 'endpoint_type', 'route_path', 'http_method', 'websocket_action', 'websocket_channel']
    )
    
    # Create index for endpoint_type filtering
    op.create_index(
        'ix_endpoint_sla_type',
        'endpoint_sla_metrics',
        ['endpoint_type', 'window_start']
    )
    
    # Create index for WebSocket-specific queries
    op.create_index(
        'ix_endpoint_sla_websocket',
        'endpoint_sla_metrics',
        ['endpoint_type', 'websocket_action', 'websocket_channel']
    )


def downgrade() -> None:
    # Drop WebSocket-specific indexes
    op.drop_index('ix_endpoint_sla_websocket', table_name='endpoint_sla_metrics')
    op.drop_index('ix_endpoint_sla_type', table_name='endpoint_sla_metrics')
    
    # Drop the new unique constraint
    op.drop_constraint('uq_endpoint_sla_window', 'endpoint_sla_metrics', type_='unique')
    
    # Recreate the old unique constraint
    op.create_unique_constraint(
        'uq_endpoint_sla_window',
        'endpoint_sla_metrics',
        ['window_start', 'http_method', 'route_path']
    )
    
    # Restore http_method to NOT NULL
    op.alter_column(
        'endpoint_sla_metrics',
        'http_method',
        existing_type=sa.String(length=10),
        nullable=False,
        comment="HTTP method (GET, POST, PUT, DELETE, PATCH, etc.)"
    )
    
    # Drop WebSocket-specific columns
    op.drop_column('endpoint_sla_metrics', 'avg_connection_duration_seconds')
    op.drop_column('endpoint_sla_metrics', 'total_connections')
    op.drop_column('endpoint_sla_metrics', 'websocket_channel')
    op.drop_column('endpoint_sla_metrics', 'websocket_action')
    op.drop_column('endpoint_sla_metrics', 'endpoint_type')
