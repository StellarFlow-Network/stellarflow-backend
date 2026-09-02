"""app/core/logging.py — Structured JSON logging configuration for StellarFlow.

Provides a single ``configure_logging()`` entry point that wires structlog
to the stdlib ``logging`` module so that **every** ``logging.getLogger(name)``
call anywhere in the codebase emits newline-delimited JSON, ready for ELK /
Datadog ingestion.

Design decisions
----------------
* **stdlib bridge** — we configure structlog's ``ProcessorFormatter`` as the
  stdlib handler formatter.  This means all existing ``logging.getLogger()``
  calls are automatically captured; no per-module migration is needed beyond
  swapping the logger accessor to ``structlog.get_logger()``.

* **Shared processor chain** — pre-chain processors run before the renderer
  for both structlog-native and stdlib-routed events, so the output shape is
  identical regardless of which logger a module uses.

* **Context variables** — ``trace_id``, ``ledger_sequence``, ``account_id``,
  and ``environment`` are stored in ``contextvars.ContextVar`` so they can be
  injected once per request/task and appear in every subsequent log line
  without passing them around explicitly.

* **Redaction** — ``SensitiveDataRedactor`` scans every log event dict for
  keys whose names match a configurable deny-list and replaces the value with
  ``"[REDACTED]"``.  String values are also scanned for PEM / private-key
  material via regex.

* **Log level** — controlled by the ``LOG_LEVEL`` environment variable
  (default ``INFO``).  ``DEBUG`` enables pretty-printed console output in
  development when ``LOG_FORMAT=console`` is also set.

Usage
-----
Call ``configure_logging()`` exactly **once** at process startup, before any
other imports that might trigger a log call::

    from app.core.logging import configure_logging
    configure_logging()

Inject per-request context from FastAPI middleware::

    from app.core.logging import bind_request_context, clear_request_context
    bind_request_context(trace_id="abc", account_id="GABC...")

Inject per-task context from a Celery signal::

    from app.core.logging import bind_contextvars
    bind_contextvars(trace_id=task.request.id, environment="production")
"""

from __future__ import annotations

import logging
import logging.config
import os
import re
import sys
from contextvars import ContextVar
from typing import Any, Dict, Optional

import structlog
from structlog.types import EventDict, WrappedLogger

# ---------------------------------------------------------------------------
# Context variables — injected once per request / task, read by the processor
# ---------------------------------------------------------------------------

_trace_id_var: ContextVar[Optional[str]] = ContextVar("trace_id", default=None)
_ledger_sequence_var: ContextVar[Optional[int]] = ContextVar(
    "ledger_sequence", default=None
)
_account_id_var: ContextVar[Optional[str]] = ContextVar("account_id", default=None)
_environment_var: ContextVar[Optional[str]] = ContextVar(
    "environment",
    default=os.environ.get("ENVIRONMENT", os.environ.get("ENV", "unknown")),
)

# ---------------------------------------------------------------------------
# Sensitive key deny-list and PEM pattern for redaction
# ---------------------------------------------------------------------------

#: Exact or partial key names (case-insensitive) whose values are redacted.
_SENSITIVE_KEYS: frozenset[str] = frozenset(
    {
        # Generic secrets
        "password",
        "passwd",
        "secret",
        "token",
        "api_key",
        "apikey",
        "api_secret",
        "access_key",
        "access_token",
        "refresh_token",
        "auth_token",
        "authorization",
        "x-api-key",
        # AWS / cloud credentials
        "aws_secret_access_key",
        "aws_session_token",
        "aws_access_key_id",
        # Cryptographic material
        "private_key",
        "private_key_b64",
        "seed",
        "mnemonic",
        "signing_key",
        "vault_token",
        "kms_key",
        "kms_secret",
        # Stellar / blockchain specifics
        "stellar_secret",
        "stellar_seed",
        "secret_key",
        "encryption_key",
        # Database / connection strings
        "database_url",
        "db_url",
        "db_password",
        "redis_url",
        "broker_url",
        "celery_broker_url",
        # HMAC / webhook secrets
        "anchor_webhook_secret",
        "webhook_secret",
        "hmac_secret",
    }
)

#: Matches PEM-encoded private key material anywhere inside a string value.
_PEM_PRIVATE_KEY_RE: re.Pattern[str] = re.compile(
    r"-----BEGIN[^-]+PRIVATE KEY-----.*?-----END[^-]+PRIVATE KEY-----",
    re.DOTALL | re.IGNORECASE,
)

#: Matches raw base64 blobs of 40+ chars that look like key material.
_RAW_KEY_RE: re.Pattern[str] = re.compile(r"[A-Za-z0-9+/=]{40,}")


def _is_sensitive_key(key: str) -> bool:
    """Return True if *key* matches any entry in the sensitive-keys deny-list."""
    lower = key.lower()
    return any(sensitive in lower for sensitive in _SENSITIVE_KEYS)


def _redact_value(value: Any) -> Any:
    """Redact PEM blocks and suspicious raw key strings inside string values."""
    if not isinstance(value, str):
        return value
    if _PEM_PRIVATE_KEY_RE.search(value):
        return "[REDACTED]"
    # Redact raw strings that are unusually long and look like key material
    # (e.g. Stellar secret keys start with 'S' and are 56 chars long).
    if len(value) >= 40 and _RAW_KEY_RE.fullmatch(value):
        return "[REDACTED]"
    return value


# ---------------------------------------------------------------------------
# Processors
# ---------------------------------------------------------------------------


def _inject_context_vars(
    logger: WrappedLogger, method: str, event_dict: EventDict
) -> EventDict:
    """Inject active context-variable values into every log event."""
    trace_id = _trace_id_var.get()
    if trace_id is not None:
        event_dict.setdefault("trace_id", trace_id)

    ledger_sequence = _ledger_sequence_var.get()
    if ledger_sequence is not None:
        event_dict.setdefault("ledger_sequence", ledger_sequence)

    account_id = _account_id_var.get()
    if account_id is not None:
        event_dict.setdefault("account_id", account_id)

    environment = _environment_var.get()
    if environment is not None:
        event_dict.setdefault("environment", environment)

    return event_dict


class SensitiveDataRedactor:
    """Structlog processor that scrubs sensitive fields from log event dicts.

    Recursively walks the event dict and redacts any key that appears in
    ``_SENSITIVE_KEYS`` (case-insensitive substring match).  String values
    that contain PEM private-key material are also redacted regardless of
    their key name.
    """

    def __call__(
        self, logger: WrappedLogger, method: str, event_dict: EventDict
    ) -> EventDict:
        self._scrub(event_dict)
        return event_dict

    def _scrub(self, mapping: Dict[str, Any]) -> None:
        for key in list(mapping.keys()):
            value = mapping[key]
            if _is_sensitive_key(key):
                mapping[key] = "[REDACTED]"
            elif isinstance(value, dict):
                self._scrub(value)
            elif isinstance(value, str):
                mapping[key] = _redact_value(value)


# ---------------------------------------------------------------------------
# Public context-management helpers
# ---------------------------------------------------------------------------


def bind_contextvars(**kwargs: Any) -> None:
    """Set one or more context variables for the current async context.

    Recognised keys: ``trace_id``, ``ledger_sequence``, ``account_id``,
    ``environment``.  Unknown keys are passed to structlog's own
    ``contextvars.bind_contextvars`` so they appear in logs automatically.

    Example::

        bind_contextvars(trace_id="abc-123", account_id="GABC...")
    """
    _KNOWN: Dict[str, ContextVar] = {  # type: ignore[type-arg]
        "trace_id": _trace_id_var,
        "ledger_sequence": _ledger_sequence_var,
        "account_id": _account_id_var,
        "environment": _environment_var,
    }
    extra: Dict[str, Any] = {}
    for key, value in kwargs.items():
        if key in _KNOWN:
            _KNOWN[key].set(value)
        else:
            extra[key] = value
    if extra:
        structlog.contextvars.bind_contextvars(**extra)


def clear_contextvars() -> None:
    """Reset all context variables to their defaults for the current context.

    Should be called at the end of each request or Celery task to prevent
    context leak between logical units of work.
    """
    _trace_id_var.set(None)
    _ledger_sequence_var.set(None)
    _account_id_var.set(None)
    _environment_var.set(
        os.environ.get("ENVIRONMENT", os.environ.get("ENV", "unknown"))
    )
    structlog.contextvars.clear_contextvars()


def bind_request_context(
    *,
    trace_id: Optional[str] = None,
    account_id: Optional[str] = None,
    ledger_sequence: Optional[int] = None,
    environment: Optional[str] = None,
) -> None:
    """Convenience wrapper for HTTP request handlers.

    Equivalent to calling :func:`bind_contextvars` with the named fields.
    """
    kwargs: Dict[str, Any] = {}
    if trace_id is not None:
        kwargs["trace_id"] = trace_id
    if account_id is not None:
        kwargs["account_id"] = account_id
    if ledger_sequence is not None:
        kwargs["ledger_sequence"] = ledger_sequence
    if environment is not None:
        kwargs["environment"] = environment
    if kwargs:
        bind_contextvars(**kwargs)


# ---------------------------------------------------------------------------
# Core configuration
# ---------------------------------------------------------------------------

#: Set to True once configure_logging() has been called to guard re-entry.
_configured: bool = False


def configure_logging(
    *,
    log_level: Optional[str] = None,
    log_format: Optional[str] = None,
    service_name: str = "stellarflow-backend",
) -> None:
    """Wire structlog and the stdlib ``logging`` root logger for JSON output.

    Parameters
    ----------
    log_level:
        Override the log level.  Falls back to the ``LOG_LEVEL`` environment
        variable, then ``INFO``.
    log_format:
        ``"json"`` (default, production) or ``"console"`` (pretty, development).
        Falls back to the ``LOG_FORMAT`` environment variable.
    service_name:
        Fixed ``service`` field added to every log record.

    This function is idempotent — calling it a second time is a no-op.
    """
    global _configured
    if _configured:
        return
    _configured = True

    level_name = (
        log_level
        or os.environ.get("LOG_LEVEL", "INFO")
    ).upper()
    level = getattr(logging, level_name, logging.INFO)

    fmt = (log_format or os.environ.get("LOG_FORMAT", "json")).lower()
    use_json = fmt != "console"

    # ------------------------------------------------------------------
    # Shared pre-chain: runs for both structlog-native and stdlib-routed
    # log records before the final renderer.
    # ------------------------------------------------------------------
    shared_processors: list[Any] = [
        # Merge context-variable bindings set via structlog.contextvars
        structlog.contextvars.merge_contextvars,
        # Inject our own ContextVar values (trace_id, etc.)
        _inject_context_vars,
        # Redact sensitive fields
        SensitiveDataRedactor(),
        # Add log level as a string field
        structlog.stdlib.add_log_level,
        # Add logger name
        structlog.stdlib.add_logger_name,
        # ISO-8601 timestamp
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        # Render exception info into the event dict
        structlog.processors.format_exc_info,
        # Render stack info
        structlog.processors.StackInfoRenderer(),
        # Normalise Unicode
        structlog.processors.UnicodeDecoder(),
    ]

    # ------------------------------------------------------------------
    # Configure structlog itself
    # ------------------------------------------------------------------
    structlog.configure(
        processors=shared_processors
        + [
            # Prepare the event dict for the stdlib formatter that follows
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    # ------------------------------------------------------------------
    # Build the stdlib formatter that structlog hands off to
    # ------------------------------------------------------------------
    if use_json:
        renderer: Any = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer(colors=sys.stderr.isatty())

    formatter = structlog.stdlib.ProcessorFormatter(
        # foreign_pre_chain applies to records that were NOT created via
        # structlog (i.e. plain logging.getLogger() calls from libraries).
        foreign_pre_chain=shared_processors,
        processors=[
            # Strip the _record and _from_structlog keys added internally
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            # Add a static service field to every record
            lambda _lg, _meth, ed: {**ed, "service": service_name},
            renderer,
        ],
    )

    # ------------------------------------------------------------------
    # Configure stdlib root logger to use the formatter above
    # ------------------------------------------------------------------
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(level)

    # Silence excessively chatty third-party loggers
    for noisy in ("urllib3", "botocore", "boto3", "asyncio", "aiohttp.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
