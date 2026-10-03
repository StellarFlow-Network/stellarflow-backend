"""FastAPI entrypoint for the StellarFlow Python service.

Issue #824 — Shielded Transaction Proof Verification Offloading Engine
Issue #NEW — Cryptographically Signed Audit Logging System for Administrative Operations
Issue #973 — Build Automated API Endpoint Performance SLA Monitoring Middleware

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
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.logging import bind_request_context, clear_contextvars
from app.middleware.sla_monitoring import SLAMonitoringMiddleware
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
from app.security.kms import KeyRotationHandler, LocalVaultProvider
from app.services.audit_logger import init_audit_logger
from app.services.auth_challenge import create_auth_challenge, consume_auth_challenge

# Import routers
try:
    from app.routers import revenue as revenue_router
    _HAS_REVENUE_ROUTER = True
except ImportError:
    _HAS_REVENUE_ROUTER = False

try:
    from app.routers.shielded import router as shielded_router
    _HAS_SHIELDED_ROUTER = True
except ImportError:
    _HAS_SHIELDED_ROUTER = False

try:
    from app.routers import rebalancing as rebalancing_router
    _HAS_REBALANCING_ROUTER = True
except ImportError:
    _HAS_REBALANCING_ROUTER = False

try:
    from app.routers import streaming as streaming_router
    _HAS_STREAMING_ROUTER = True
except ImportError:
    _HAS_STREAMING_ROUTER = False

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
    
    # Initialize KMS and audit logging system
    try:
        # Initialize with LocalVaultProvider for development/stub mode
        # In production, this would use AwsKmsProvider with proper configuration
        provider = LocalVaultProvider()
        _key_handler = KeyRotationHandler(provider)
        await _key_handler.start()
        
        # Initialize the audit logger with the KMS key handler
        init_audit_logger(_key_handler)
        log.info("KMS and audit logging system initialized successfully")
    except Exception as exc:
        log.error("Failed to initialize KMS and audit logging system", error=str(exc))
        # Continue running even if audit logging fails to not break other services
    
    # Initialize WebSocket streaming managers
    if _HAS_STREAMING_ROUTER:
        try:
            import os
            redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
            await streaming_router.init_streaming_managers(redis_url=redis_url)
            log.info("WebSocket streaming managers initialized", redis_url=redis_url)
        except Exception as exc:
            log.error("Failed to initialize streaming managers", error=str(exc))
    
    yield
    
    # Shutdown
    log.info("stellarflow.shutdown")
    
    # Shutdown streaming managers
    if _HAS_STREAMING_ROUTER:
        try:
            await streaming_router.shutdown_streaming_managers()
            log.info("WebSocket streaming managers shut down")
        except Exception as exc:
            log.error("Failed to shutdown streaming managers", error=str(exc))
    
    await stop_latency_monitor()
    shutdown_process_pool()
    shutdown_pools()
    
    # Note: shutdown_tracing() is called but not defined in the visible code
    # Commenting out to avoid errors
    # shutdown_tracing()


# ---------------------------------------------------------------------------
# Application instance
# ---------------------------------------------------------------------------

app = FastAPI(
    title="StellarFlow Backend Services",
    description="Combined service including proof verification, revenue tracking, compliance audit logging, and SLA monitoring",
    version="1.0.0",
    lifespan=lifespan,
)

# Add middleware (order matters: last added = first executed)
# SLA monitoring should be outer layer to track all requests including middleware overhead
app.add_middleware(SLAMonitoringMiddleware, sla_target_p99_ms=200.0)
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
        log.exception("Auth challenge creation failed", error=str(exc))
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
        log.exception("Auth challenge consumption failed", error=str(exc))
        raise HTTPException(
            status_code=503, detail="Authentication unavailable"
        ) from exc

    if not consumed:
        raise HTTPException(status_code=401, detail="Invalid or expired challenge")

    return JSONResponse({"success": True, "data": {"consumed": True}})


@app.get("/health")
async def health() -> JSONResponse:
    """Health check endpoint for load balancers and monitoring."""
    return JSONResponse(
        {
            "status": "ok",
            "success": True,
            "service": "stellarflow-backend",
            "processPoolWorkers": PROOF_PROCESS_POOL_WORKERS,
            "cacheTtlSeconds": PROOF_CACHE_TTL_SECONDS,
            "streaming_enabled": _HAS_STREAMING_ROUTER,
        }
    )

if _HAS_REVENUE_ROUTER:
    app.include_router(revenue_router.router, prefix="/api/v1")

if _HAS_SHIELDED_ROUTER:
    app.include_router(shielded_router, prefix="/api/v1")

if _HAS_REBALANCING_ROUTER:
    app.include_router(rebalancing_router.router, prefix="/api/v1")

if _HAS_STREAMING_ROUTER:
    app.include_router(streaming_router.router, prefix="/api")
