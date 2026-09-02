from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from src.api.v1.router import v1_router
from src.cache.redis_cache import redis_cache

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle manager for startup and shutdown events."""
    logger.info("Initializing FastAPI StellarFlow Analytics Application...")
    await redis_cache.connect()
    yield
    logger.info("Shutting down FastAPI application and disconnecting Redis...")
    await redis_cache.disconnect()


app = FastAPI(
    title="StellarFlow Market Analytics API",
    description=(
        "FastAPI REST Endpoint Suite for Market Analytics Data, Liquidity Pool Statistics, "
        "and System Health with 15-second Redis Response Caching."
    ),
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
    openapi_tags=[
        {
            "name": "Pools",
            "description": "Liquidity pool statistics and market analytics endpoints",
        },
        {
            "name": "Analytics",
            "description": "Aggregated market trading volume and time-series analytics",
        },
        {
            "name": "Health",
            "description": "System health, service status, and telemetry monitoring",
        },
    ],
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount v1 API router
app.include_router(v1_router)


@app.get("/", include_in_schema=False)
async def root():
    """Root redirect / index metadata."""
    return {
        "name": "StellarFlow Market Analytics API",
        "version": "1.0.0",
        "docs": "/docs",
        "openapi": "/openapi.json",
    }


__all__ = ["app"]
