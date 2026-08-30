"""Celery application and periodic task configuration."""

import os

from celery import Celery
from celery.schedules import crontab

from app.telemetry import instrument_celery, setup_tracing

# The celery-worker / celery-beat processes are separate Python processes
# from the FastAPI app, so tracing must be initialised here too (Issue
# #760). instrument_celery() hooks Celery's before_task_publish /
# task_prerun signals so the W3C traceparent header is propagated through
# the RabbitMQ task message headers automatically: a span started while
# handling an HTTP request that calls a task's .delay()/.apply_async()
# continues, as a child span, inside whichever worker picks the task up.
setup_tracing()
instrument_celery()

celery_app = Celery(
    "stellarflow",
    broker=os.getenv("CELERY_BROKER_URL", "amqp://guest:guest@rabbitmq:5672//"),
    backend=os.getenv("CELERY_RESULT_BACKEND", "rpc://"),
    include=["app.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    beat_schedule={
        "poll-anchor-settlement-statuses": {
            "task": "app.tasks.poll_anchor_settlement_statuses",
            "schedule": 30.0,
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
    },
)
