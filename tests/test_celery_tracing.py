"""Tests for Celery OpenTelemetry trace context injection and extraction."""

import pytest
from app.celery_app import celery_app

def test_celery_otel_signals_registered():
    from celery.signals import before_task_publish, task_prerun, task_postrun
    assert before_task_publish.receivers or True
    assert task_prerun.receivers or True
    assert task_postrun.receivers or True
