"""RFC 7807 problem responses for the FastAPI service."""

import logging
from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from sqlalchemy.exc import SQLAlchemyError

try:
    import asyncpg
except ImportError:  # asyncpg is a declared runtime dependency, but optional for tooling.
    asyncpg = None

try:
    import psycopg2
except ImportError:  # psycopg2 is optional for minimal test/runtime environments.
    psycopg2 = None

logger = logging.getLogger(__name__)


def _problem(
    request: Request,
    status: int,
    detail: str,
    title: str | None = None,
    headers: dict[str, str] | None = None,
):
    """Build a stable RFC 7807 response without exposing exception internals."""
    try:
        resolved_title = title or HTTPStatus(status).phrase
    except ValueError:
        resolved_title = "Request failed"
    return JSONResponse(
        status_code=status,
        media_type="application/problem+json",
        headers=headers,
        content={
            "type": "about:blank",
            "title": resolved_title,
            "status": status,
            "detail": detail,
            "instance": request.url.path,
        },
    )


def register_problem_handlers(app: FastAPI) -> None:
    """Install consistent client, validation, database, and fallback handlers."""

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(request: Request, exc: StarletteHTTPException):
        detail = str(exc.detail) if exc.status_code < 500 else "The server could not process the request."
        return _problem(request, exc.status_code, detail, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_exception(request: Request, _exc: RequestValidationError):
        return _problem(request, 422, "One or more request fields are invalid.", "Request validation failed")

    @app.exception_handler(SQLAlchemyError)
    async def handle_sqlalchemy_exception(request: Request, exc: SQLAlchemyError):
        logger.exception("Database operation failed", exc_info=exc)
        return _problem(request, 500, "A database operation failed.", "Internal Server Error")

    if asyncpg is not None:
        @app.exception_handler(asyncpg.PostgresError)
        async def handle_postgres_exception(request: Request, exc):
            logger.exception("Database operation failed", exc_info=exc)
            return _problem(request, 500, "A database operation failed.", "Internal Server Error")

    if psycopg2 is not None:
        @app.exception_handler(psycopg2.Error)
        async def handle_psycopg_exception(request: Request, exc):
            logger.exception("Database operation failed", exc_info=exc)
            return _problem(request, 500, "A database operation failed.", "Internal Server Error")

    @app.exception_handler(Exception)
    async def handle_unexpected_exception(request: Request, exc: Exception):
        logger.exception("Unhandled request exception", exc_info=exc)
        return _problem(request, 500, "An unexpected server error occurred.", "Internal Server Error")
