"""FastAPI entrypoint for the StellarFlow Python service.

Issue #824 — Shielded Transaction Proof Verification Offloading Engine

The Dockerfile starts this module with:
    uvicorn app.main:app --host 0.0.0.0 --port 8000
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

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
from app.telemetry import (
    instrument_datastores,
    instrument_fastapi_app,
    instrument_http_clients,
    setup_tracing,
    shutdown_tracing,
)

try:
    from app.routers import revenue as revenue_router
    _HAS_REVENUE_ROUTER = True
except ImportError:
    _HAS_REVENUE_ROUTER = False

logger = logging.getLogger(__name__)

# Initialise OpenTelemetry APM tracing as early as possible so every
# instrumentation hook below attaches before the first request or
# background task runs (Issue #760). Both calls are no-ops unless
# TRACING_ENABLED=true, so this is safe in every environment.
setup_tracing()
instrument_http_clients()
instrument_datastores()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage executor pools and latency monitor lifecycle."""
    get_process_pool()
    get_heavy_pool()
    await start_latency_monitor()
    yield
    await stop_latency_monitor()
    shutdown_process_pool()
    shutdown_pools()
    shutdown_tracing()


app = FastAPI(
    title="StellarFlow Proof Verification Engine",
    description="Issue #824 — Offloaded ZK proof verification with async process pools",
    version="1.0.0",
    lifespan=lifespan,
)

# Instrument every FastAPI endpoint with a request span (Issue #760). The
# incoming traceparent header, if present, becomes the span's parent so a
# request that originated in the Node service continues the same trace.
instrument_fastapi_app(app)


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


@app.post("/proof/verify", response_model=ProofVerificationResponse)
async def verify_proof(request: ProofVerificationRequest) -> ProofVerificationResponse:
    """Verify a single shielded transaction proof.

    Offloads CPU-intensive ZK proof checks to a background worker process pool.
    Returns cached results within the 100ms latency budget when available.
    """
    try:
        result = await verify_proof_async(
            proof_hex=request.proof.proof_hex,
            public_inputs=request.proof.public_inputs,
            contract_params=request.proof.contract_params,
            proof_scheme=request.proof.proof_scheme.value,
            simulate_contract=request.simulate_contract,
        )
        return ProofVerificationResponse(
            success=True,
            result=result,
        )
    except Exception as exc:
        logger.exception("Proof verification endpoint error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/proof/verify-batch")
async def verify_proof_batch_endpoint(
    requests: list[ProofVerificationRequest],
) -> JSONResponse:
    """Verify multiple shielded transaction proofs concurrently."""
    if not requests:
        raise HTTPException(status_code=400, detail="requests list is empty")

    try:
        payloads = [req.model_dump() for req in requests]
        results = await verify_proof_batch(payloads)
        return JSONResponse(
            {
                "success": True,
                "results": [r.to_dict() for r in results],
            }
        )
    except Exception as exc:
        logger.exception("Batch proof verification endpoint error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/proof/pool-status")
async def pool_status() -> JSONResponse:
    """Return process pool status for observability."""
    pool = get_process_pool()
    return JSONResponse(
        {
            "success": True,
            "maxWorkers": PROOF_PROCESS_POOL_WORKERS,
        }
    )


@app.get("/proof/latency")
async def latency_status() -> JSONResponse:
    """Return event-loop latency monitor status."""
    monitor = get_latency_monitor()
    return JSONResponse(
        {
            "success": True,
            "budgetMs": LATENCY_BUDGET_MS,
            "maxLatencyMs": round(monitor.max_latency_ms, 3),
            "avgLatencyMs": round(monitor.avg_latency_ms, 3),
            "violationCount": monitor.violation_count,
            "isHealthy": monitor.is_healthy,
        }
    )


# Include existing routers (if any)
try:
    from app.adapters.anchor import router as anchor_router

    app.include_router(anchor_router, prefix="/webhook", tags=["Webhooks"])
except ImportError:
    pass

if _HAS_REVENUE_ROUTER:
    app.include_router(revenue_router.router, tags=["Analytics"])
