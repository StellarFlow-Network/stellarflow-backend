"""FastAPI entrypoint for the StellarFlow Python service.

Issue #824 — Shielded Transaction Proof Verification Offloading Engine

The Dockerfile starts this module with:
    uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

# ---------------------------------------------------------------------------
# Logging MUST be configured before any other app imports so that every
# module that calls logging.getLogger() at import time is already wired to
# the structlog JSON pipeline.
# ---------------------------------------------------------------------------
from app.core.logging import configure_logging  # noqa: E402 — intentional first import

configure_logging()

import uuid
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.core.logging import bind_request_context, clear_contextvars
from app.models.proof import ProofVerificationRequest, ProofVerificationResponse
from app.services.executor_pool import (
    LATENCY_BUDGET_MS,
    get_heavy_pool,
    get_latency_monitor,
    shutdown_pools,
    start_latency_monitor,
    stop_latency_monitor,
)
from app.services.proof_verification_engine import (
    PROOF_CACHE_TTL_SECONDS,
    PROOF_PROCESS_POOL_WORKERS,
    get_process_pool,
    shutdown_process_pool,
    verify_proof_async,
    verify_proof_batch,
)

try:
    from app.routers import revenue as revenue_router
    _HAS_REVENUE_ROUTER = True
except ImportError:
    _HAS_REVENUE_ROUTER = False

log = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Request-scoped logging middleware
# ---------------------------------------------------------------------------

class StructlogRequestMiddleware(BaseHTTPMiddleware):
    """Inject a per-request trace_id into the structlog context.

    For every inbound HTTP request:
    - Reads ``X-Trace-Id`` from the request headers (set by a gateway or
      load-balancer upstream), or generates a fresh UUID4 when absent.
    - Binds ``trace_id``, ``method``, and ``path`` into the context so every
      log line emitted during that request carries those fields.
    - Clears the context after the response is sent to prevent leakage.
    - Logs a single ``request.completed`` record with the HTTP status code and
      wall-clock duration (ms) at the end of each request.
    """

    async def dispatch(self, request: Request, call_next):
        trace_id = request.headers.get("x-trace-id") or str(uuid.uuid4())

        bind_request_context(trace_id=trace_id)
        # Bind method + path for the lifetime of this request
        structlog.contextvars.bind_contextvars(
            http_method=request.method,
            http_path=request.url.path,
        )

        import time
        start = time.monotonic()
        try:
            response = await call_next(request)
            elapsed_ms = round((time.monotonic() - start) * 1000, 2)
            log.info(
                "request.completed",
                status_code=response.status_code,
                duration_ms=elapsed_ms,
            )
            # Echo the trace_id back to the caller so it can be correlated
            response.headers["x-trace-id"] = trace_id
            return response
        except Exception:
            elapsed_ms = round((time.monotonic() - start) * 1000, 2)
            log.exception("request.failed", duration_ms=elapsed_ms)
            raise
        finally:
            clear_contextvars()


# ---------------------------------------------------------------------------
# Application lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage executor pools and latency monitor lifecycle."""
    log.info(
        "stellarflow.startup",
        process_pool_workers=PROOF_PROCESS_POOL_WORKERS,
        cache_ttl_seconds=PROOF_CACHE_TTL_SECONDS,
    )
    get_process_pool()
    get_heavy_pool()
    await start_latency_monitor()
    yield
    log.info("stellarflow.shutdown")
    await stop_latency_monitor()
    shutdown_process_pool()
    shutdown_pools()


# ---------------------------------------------------------------------------
# Application instance
# ---------------------------------------------------------------------------

app = FastAPI(
    title="StellarFlow Proof Verification Engine",
    description="Issue #824 — Offloaded ZK proof verification with async process pools",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(StructlogRequestMiddleware)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

class AuthChallengeConsumeRequest(BaseModel):
    nonce: str


@app.post("/api/v1/auth/challenge")
async def auth_challenge() -> JSONResponse:
    """Issue a one-time authentication challenge nonce."""
    try:
        nonce = await create_auth_challenge()
        return JSONResponse({"success": True, "data": {"nonce": nonce}})
    except Exception as exc:
        logger.exception("Auth challenge creation failed: %s", exc)
        raise HTTPException(
            status_code=503, detail="Authentication unavailable"
        ) from exc


@app.post("/api/v1/auth/challenge/consume")
async def auth_challenge_consume(
    request: AuthChallengeConsumeRequest,
) -> JSONResponse:
    """Atomically consume an authentication challenge nonce exactly once."""
    try:
        consumed = await consume_auth_challenge(request.nonce)
    except Exception as exc:
        logger.exception("Auth challenge consumption failed: %s", exc)
        raise HTTPException(
            status_code=503, detail="Authentication unavailable"
        ) from exc

    if not consumed:
        raise HTTPException(status_code=401, detail="Invalid or expired challenge")

    return JSONResponse({"success": True, "data": {"consumed": True}})


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "success": True,
            "service": "proof-verification",
            "processPoolWorkers": PROOF_PROCESS_POOL_WORKERS,
            "cacheTtlSeconds": PROOF_CACHE_TTL_SECONDS,
        }
    )
    
    try:
        response = await call_next(request)
        return response
    except Exception as e:
        status_code = getattr(e, "status_code", 500)
        if isinstance(e, HTTPException):
            status_code = e.status_code
        if status_code in (401, 404):
            raise e
        sentry_sdk.capture_exception(e)
        raise e

app.include_router(revenue.router, prefix="/api/v1")

@app.get("/health")
def health_check():
    return {"status": "ok"}
