from __future__ import annotations

import functools
import hashlib
import json
import logging
import os
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)


class RedisCacheManager:
    """Async Redis cache manager for response caching with fallback to in-memory store."""

    def __init__(self, redis_url: Optional[str] = None, default_ttl: int = 15) -> None:
        self.default_ttl = default_ttl
        self.redis_url = redis_url or os.getenv("REDIS_URL", "redis://localhost:6379")
        self._client: Any = None
        self._fallback_store: Dict[str, tuple[str, float]] = {}
        self._connected = False

    async def connect(self) -> bool:
        """Attempt to connect to Redis."""
        if self._connected and self._client:
            return True
        try:
            import redis.asyncio as aioredis  # type: ignore

            self._client = aioredis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True,
                socket_timeout=2.0,
            )
            await self._client.ping()
            self._connected = True
            logger.info("Connected to Redis at %s", self.redis_url)
            return True
        except Exception as exc:
            logger.warning("Redis connection unavailable (%s). Using fallback store.", exc)
            self._connected = False
            self._client = None
            return False

    async def disconnect(self) -> None:
        """Close Redis connection."""
        if self._client and self._connected:
            try:
                await self._client.close()
            except Exception:
                pass
        self._connected = False
        self._client = None

    @property
    def is_connected(self) -> bool:
        return self._connected

    async def get(self, key: str) -> Optional[str]:
        """Get cached string by key."""
        if self._connected and self._client:
            try:
                return await self._client.get(key)
            except Exception as exc:
                logger.warning("Redis GET failed for key %s: %s", key, exc)
                self._connected = False

        # Fallback store lookup
        import time

        if key in self._fallback_store:
            val, expiry = self._fallback_store[key]
            if time.time() < expiry:
                return val
            else:
                del self._fallback_store[key]
        return None

    async def set(self, key: str, value: str, ttl: Optional[int] = None) -> bool:
        """Set cached string with TTL (default 15s)."""
        expiry_ttl = ttl if ttl is not None else self.default_ttl
        if self._connected and self._client:
            try:
                await self._client.set(key, value, ex=expiry_ttl)
                return True
            except Exception as exc:
                logger.warning("Redis SET failed for key %s: %s", key, exc)
                self._connected = False

        # Fallback store set
        import time

        self._fallback_store[key] = (value, time.time() + expiry_ttl)
        return True

    async def clear(self) -> None:
        """Clear cached entries."""
        if self._connected and self._client:
            try:
                await self._client.flushdb()
            except Exception:
                pass
        self._fallback_store.clear()


# Module-level singleton
redis_cache = RedisCacheManager()


def cache_response(ttl: int = 15, prefix: str = "stellarflow:cache"):
    """FastAPI endpoint decorator for response caching with 15-second Redis TTL."""

    def decorator(func: Callable):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            from fastapi import Request, Response
            from fastapi.responses import JSONResponse

            # Extract Request object from kwargs or positional args if present
            request: Optional[Request] = kwargs.get("request")
            if not request:
                for arg in args:
                    if isinstance(arg, Request):
                        request = arg
                        break

            if request:
                query_str = str(sorted(request.query_params.items()))
                raw_key = f"{request.url.path}:{query_str}"
                key_hash = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:16]
                cache_key = f"{prefix}:{request.url.path.strip('/')}:{key_hash}"
            else:
                cache_key = f"{prefix}:{func.__name__}:{hash(str(args) + str(kwargs))}"

            cached_data = await redis_cache.get(cache_key)
            if cached_data:
                try:
                    content = json.loads(cached_data)
                    return JSONResponse(
                        content=content,
                        headers={"X-Cache": "HIT", "X-Cache-TTL": str(ttl)},
                    )
                except Exception:
                    pass

            # Execute endpoint handler
            res = await func(*args, **kwargs)

            # Determine payload content for caching
            content_to_cache = None
            if hasattr(res, "dict") and callable(res.dict):
                content_to_cache = res.dict()
            elif hasattr(res, "model_dump") and callable(res.model_dump):
                content_to_cache = res.model_dump()
            elif isinstance(res, (dict, list)):
                content_to_cache = res

            if content_to_cache is not None:
                try:
                    json_str = json.dumps(content_to_cache, default=str)
                    await redis_cache.set(cache_key, json_str, ttl=ttl)
                except Exception as exc:
                    logger.warning("Failed to cache response for %s: %s", cache_key, exc)

            if isinstance(res, (dict, list)):
                return JSONResponse(
                    content=res,
                    headers={"X-Cache": "MISS", "X-Cache-TTL": str(ttl)},
                )
            elif isinstance(res, Response):
                res.headers["X-Cache"] = "MISS"
                res.headers["X-Cache-TTL"] = str(ttl)
                return res

            return res

        return wrapper

    return decorator


__all__ = ["RedisCacheManager", "redis_cache", "cache_response"]
