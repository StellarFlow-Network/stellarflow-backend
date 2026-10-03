"""Celery application and periodic task configuration."""

import os

from celery import Celery, signals
from celery.schedules import crontab
from kombu import Exchange, Queue
from opentelemetry import trace
from opentelemetry.trace import propagation

from app.sentry import init_sentry

init_sentry()

celery_app = Celery(
    "stellarflow",
    broker=os.getenv("CELERY_BROKER_URL", "amqp://guest:guest@rabbitmq:5672//"),
    backend=os.getenv("CELERY_RESULT_BACKEND", "rpc://"),
    include=["app.tasks"],
)

@signals.before_task_publish.connect
def on_before_task_publish(sender=None, headers=None, body=None, **kwargs):
    carrier = {}
    propagation.inject(carrier)
    if headers is not None:
        headers.update(carrier)
    elif body is not None and isinstance(body, dict):
        body.update(carrier)

@signals.task_prerun.connect
def on_task_prerun(sender=None, headers=None, **kwargs):
    carrier = {}
    if headers:
        carrier = {k: v for k, v in headers.items() if k.lower().startswith("traceparent") or k.lower() in ("tracestate", "uber-trace-id")}
    extracted_context = propagation.extract(carrier)
    token = trace.set_tracer_provider(trace.get_tracer_provider())
    # Attach context via OpenTelemetry trace context propagation
    from opentelemetry.context import attach
    attach(extracted_context)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_queues=(
        Queue("webhook.retry", Exchange("webhook"), routing_key="webhook.retry", durable=True),
        Queue("webhook.dead", Exchange("webhook"), routing_key="webhook.dead", durable=True),
        Queue("index-shielded-notes", Exchange("shielded"), routing_key="shielded.index", durable=True),
    ),
    task_routes={
        "app.tasks.deliver_webhook_task": {
            "queue": "webhook.retry",
            "routing_key": "webhook.retry",
        },
        "app.tasks.webhook_dead_letter_task": {
            "queue": "webhook.dead",
            "routing_key": "webhook.dead",
        },
        "app.tasks.index_shielded_notes_range": {
            "queue": "index-shielded-notes",
            "routing_key": "shielded.index",
        },
    },
    beat_schedule={
        "poll-anchor-settlement-statuses": {
            "task": "app.tasks.poll_anchor_settlement_statuses",
            "schedule": 30.0,
        },
        "monitor-fiat-settlement-latency": {
            "task": "app.tasks.monitor_fiat_settlement_latency",
            "schedule": crontab(minute="*/5"),
            "kwargs": {"lookback_hours": 24},
        },
        "aggregate-minute-analytics": {
            "task": "app.tasks.aggregate_ledger_analytics",
            "schedule": crontab(minute="*/5"),
            "kwargs": {"granularity": "MINUTE", "lookback_hours": 2},
        },
        "aggregate-hour-analytics": {
            "task": "app.tasks.aggregate_ledger_analytics",
            "schedule": crontab(minute="*/5"),
            "kwargs": {"granularity": "HOUR", "lookback_hours": 25},
        },
        "aggregate-day-analytics": {
            "task": "app.tasks.aggregate_ledger_analytics",
            "schedule": crontab(minute="*/15"),
            "kwargs": {"granularity": "DAY", "lookback_hours": 73},
        },
        "ingest-flash-loan-revenue": {
            "task": "app.tasks.ingest_flash_loan_revenue",
            "schedule": crontab(minute="*/5"),
            "kwargs": {"lookback_minutes": 60},
        },
        "compute-daily-yield-snapshots": {
            "task": "app.tasks.compute_yield_snapshots",
            "schedule": crontab(minute="*/15"),
            "kwargs": {"granularity": "DAILY"},
        },
        "compute-hourly-yield-snapshots": {
            "task": "app.tasks.compute_yield_snapshots",
            "schedule": crontab(minute="*/5"),
            "kwargs": {"granularity": "HOURLY"},
        },
        "auto-rebalance-capital": {
            # Re-evaluate the optimal allocation vector every 6 hours.
            "task": "app.tasks.auto_rebalance_capital",
            "schedule": crontab(minute="0", hour="*/6"),
        },
        "stake-treasury-idle-balances": {
            "task": "app.tasks.stake_treasury_idle_balances",
            "schedule": crontab(minute="0", hour="*/6"),
        },
        "generate-treasury-yield-report": {
            "task": "app.tasks.generate_treasury_yield_report",
            "schedule": crontab(minute="0", hour="0", day_of_month="1"),
        },
        "sweep-treasury-staked-yield": {
            "task": "app.tasks.sweep_treasury_staked_yield",
            "schedule": crontab(minute="*/15"),
        },
    },
)
