"""Celery retry entry point for nullifier-tree lock contention.

Wire this task into the repository's existing Celery application and payload
schema. Do not create a second Celery application.
"""

from __future__ import annotations

from celery import Task

from app.services.nullifier_lock import LockAcquireTimeout


class NullifierTreeRetryTask(Task):
    autoretry_for = (LockAcquireTimeout,)
    retry_backoff = True
    retry_backoff_max = 60
    retry_jitter = True
    max_retries = 5

    def on_failure(self, exc, task_id, args, kwargs, einfo):
        # Route exhausted retries to the repository's existing DLQ mechanism.
        # Replace this placeholder with the project's established DLQ API.
        return super().on_failure(exc, task_id, args, kwargs, einfo)
