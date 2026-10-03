"""Add endpoint SLA monitoring and performance tracking

Revision ID: 0009_add_endpoint_sla_monitoring
Revises: 0008_add_treasury_yield_worker
Create Date: 2026-09-29 10:00:00.000000

Issue #973 — Build Automated API Endpoint Performance SLA Monitoring Middleware

This migration creates the `endpoint_sla_metrics` table for tracking API
endpoint performance metrics, latency percentiles (P50, P95, P99), and SLA
compliance scores over configurable time windows (typically 5 minutes).

The middleware collects real-time Prometheus metrics, and a background worker
aggregates them into this table for dashboard analytics and historical trends.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '0009_add_endpoint_sla_monitoring'
down_revision = '0008_add_treasury_yield_worker'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create endpoint_sla_metrics table
    op.create_table(
        'endpoint_sla_metrics',
        sa.Column(
            'id',
            sa.BigInteger(),
            autoincrement=True,
            nullable=False,
            comment='Primary key'
        ),
        sa.Column(
            'window_start',
            sa.DateTime(timezone=True),
            nullable=False,
            comment='Start of the aggregation time window (typically 5-minute intervals)'
        ),
        sa.Column(
            'window_end',
            sa.DateTime(timezone=True),
            nullable=False,
            comment='End of the aggregation time window'
        ),
        sa.Column(
            'http_method',
            sa.String(length=10),
            nullable=False,
            comment='HTTP method (GET, POST, PUT, DELETE, PATCH, etc.)'
        ),
        sa.Column(
            'route_path',
            sa.String(length=512),
            nullable=False,
            comment='URL path pattern (e.g., /api/v1/users/{id})'
        ),
        sa.Column(
            'route_name',
            sa.String(length=256),
            nullable=True,
            comment='Optional route name from FastAPI endpoint definition'
        ),
        sa.Column(
            'total_requests',
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text('0'),
            comment='Total number of requests in this time window'
        ),
        sa.Column(
            'success_requests',
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text('0'),
            comment='Requests with 2xx status codes'
        ),
        sa.Column(
            'error_4xx_requests',
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text('0'),
            comment='Requests with 4xx client error status codes'
        ),
        sa.Column(
            'error_5xx_requests',
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text('0'),
            comment='Requests with 5xx server error status codes'
        ),
        sa.Column(
            'latency_p50_ms',
            sa.Float(),
            nullable=True,
            comment='50th percentile (median) request duration in milliseconds'
        ),
        sa.Column(
            'latency_p95_ms',
            sa.Float(),
            nullable=True,
            comment='95th percentile request duration in milliseconds'
        ),
        sa.Column(
            'latency_p99_ms',
            sa.Float(),
            nullable=True,
            comment='99th percentile request duration in milliseconds'
        ),
        sa.Column(
            'latency_max_ms',
            sa.Float(),
            nullable=True,
            comment='Maximum request duration in milliseconds'
        ),
        sa.Column(
            'latency_mean_ms',
            sa.Float(),
            nullable=True,
            comment='Mean (average) request duration in milliseconds'
        ),
        sa.Column(
            'sla_target_p99_ms',
            sa.Float(),
            nullable=False,
            server_default=sa.text('200.0'),
            comment='Target P99 latency threshold in milliseconds (default 200ms)'
        ),
        sa.Column(
            'sla_compliant',
            sa.Boolean(),
            nullable=False,
            server_default=sa.text('true'),
            comment='True if P99 latency stayed within the SLA target during this window'
        ),
        sa.Column(
            'sla_violations',
            sa.Integer(),
            nullable=False,
            server_default=sa.text('0'),
            comment='Number of times P99 exceeded threshold during this window'
        ),
        sa.Column(
            'compliance_score',
            sa.Float(),
            nullable=True,
            comment=(
                'Overall compliance score (0.0-1.0) based on latency, error rate, '
                'and availability during this window'
            )
        ),
        sa.Column(
            'alert_triggered',
            sa.Boolean(),
            nullable=False,
            server_default=sa.text('false'),
            comment='True if an SLA violation alert was sent for this window'
        ),
        sa.Column(
            'alert_sent_at',
            sa.DateTime(timezone=True),
            nullable=True,
            comment='Timestamp when the alert notification was sent'
        ),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text('now()'),
            comment='When this record was inserted'
        ),
        sa.Column(
            'notes',
            sa.Text(),
            nullable=True,
            comment='Optional notes or error details for investigation'
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'window_start',
            'http_method',
            'route_path',
            name='uq_endpoint_sla_window'
        ),
        comment=(
            'SLA compliance metrics for REST and WebSocket routes. '
            'Stores aggregated performance data over time windows for '
            'dashboard analytics and historical trend tracking.'
        )
    )

    # Create indexes for efficient queries
    
    # Index for time-based queries (most common access pattern)
    op.create_index(
        'ix_endpoint_sla_metrics_window_start',
        'endpoint_sla_metrics',
        ['window_start']
    )
    
    # Index for route-based queries
    op.create_index(
        'ix_endpoint_sla_metrics_route_path',
        'endpoint_sla_metrics',
        ['route_path']
    )
    
    # Composite index for dashboard queries (recent metrics by endpoint)
    op.create_index(
        'ix_endpoint_sla_route_time',
        'endpoint_sla_metrics',
        ['route_path', 'window_start']
    )
    
    # Index for SLA compliance queries (violations in time range)
    op.create_index(
        'ix_endpoint_sla_compliance',
        'endpoint_sla_metrics',
        ['sla_compliant', 'window_start']
    )
    
    # Index for alert tracking queries
    op.create_index(
        'ix_endpoint_sla_alerts',
        'endpoint_sla_metrics',
        ['alert_triggered', 'window_start']
    )


def downgrade() -> None:
    # Drop indexes
    op.drop_index('ix_endpoint_sla_alerts', table_name='endpoint_sla_metrics')
    op.drop_index('ix_endpoint_sla_compliance', table_name='endpoint_sla_metrics')
    op.drop_index('ix_endpoint_sla_route_time', table_name='endpoint_sla_metrics')
    op.drop_index('ix_endpoint_sla_metrics_route_path', table_name='endpoint_sla_metrics')
    op.drop_index('ix_endpoint_sla_metrics_window_start', table_name='endpoint_sla_metrics')
    
    # Drop table
    op.drop_table('endpoint_sla_metrics')
