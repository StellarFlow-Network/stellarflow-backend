import os
import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.celery import CeleryIntegration
from sentry_sdk.integrations.logging import LoggingIntegration

def before_send(event, hint):
    if "exc_info" in hint:
        exc_type, exc_value, tb = hint["exc_info"]
        # Suppress reporting for standard client errors (e.g. 401, 404 or specific status code attributes)
        status_code = getattr(exc_value, "status_code", None)
        if status_code in (401, 404):
            return None
        # Also inspect http status in exception message or args if present
        msg = str(exc_value)
        if "401" in msg or "404" in msg or "Unauthorized" in msg or "Not Found" in msg:
            if "status" in msg.lower() or "code" in msg.lower():
                return None
    return event

def init_sentry():
    dsn = os.getenv("SENTRY_DSN")
    if not dsn:
        return
    sentry_sdk.init(
        dsn=dsn,
        integrations=[
            FastApiIntegration(),
            CeleryIntegration(),
            LoggingIntegration(level=os.getenv("SENTRY_LOG_LEVEL", "INFO"), event_level="ERROR"),
        ],
        traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
        environment=os.getenv("ENVIRONMENT", "production"),
        before_send=before_send,
    )

def set_sentry_context(ledger_sequence: int = None, user_id: str = None, trace_id: str = None):
    if ledger_sequence is not None:
        sentry_sdk.set_tag("ledger_sequence", str(ledger_sequence))
    if user_id is not None:
        sentry_sdk.set_tag("user_id", user_id)
        sentry_sdk.set_user({"id": user_id})
    if trace_id is not None:
        sentry_sdk.set_tag("trace_id", trace_id)
