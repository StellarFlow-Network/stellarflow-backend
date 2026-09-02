from __future__ import annotations

from fastapi import APIRouter
from src.api.v1.analytics import router as analytics_router
from src.api.v1.health import router as health_router
from src.api.v1.pools import router as pools_router

v1_router = APIRouter(prefix="/api/v1")
v1_router.include_router(pools_router)
v1_router.include_router(analytics_router)
v1_router.include_router(health_router)

__all__ = ["v1_router"]
