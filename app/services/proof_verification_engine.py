"""app/services/proof_verification_engine.py

Issue #824 — Shielded Transaction Proof Verification Offloading Engine

Offloads heavy ZK proof verification to background process pools so that the
main API process is never blocked by CPU-bound elliptic-curve or pairing-based
checks.

Architecture
------------
1. **Structure validation** (synchronous, cheap)
   - Required fields, hex encoding, size bounds, scheme enum.
   - Runs in the API worker before any heavy lifting.

2. **Contract simulation guard** (synchronous, cheap)
   - Validates that contract simulation parameters are well-formed
   - Ensures parameter types and sizes are compatible with Soroban contract calls.

3. **Process-pool offload** (asynchronous, expensive)
   - ``concurrent.futures.ProcessPoolExecutor`` with configurable worker count.
   - Each worker process receives the proof payload and performs the
     CPU-intensive verification computation.
   - ``asyncio.get_event_loop().run_in_executor`` bridges the pool into the
     async FastAPI request handler without blocking the event loop.

4. **Two-tier caching** (sub-100ms fast path)
   - L1: process-local ``dict`` (nanosecond lookups).
   - L2: Redis sorted set with per-entry TTL.
   - A cached hit short-circuits the pool entirely and returns within the
     latency budget.

5. **Event-loop latency tracking**
   - ``verify_proof_async`` measures the event-loop overhead of dispatching
     to the pool so that latency regressions are visible in logs.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import structlog

from app.services.executor_pool import get_heavy_pool, shutdown_pools

log = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

#: Maximum number of worker processes for the verification pool.
#: Defaults to the number of CPU cores reported by the OS.
PROOF_PROCESS_POOL_WORKERS: int = int(
    os.getenv("PROOF_PROCESS_POOL_WORKERS", str(os.cpu_count() or 4))
)

#: TTL (seconds) for cached proof validation results in Redis.
PROOF_CACHE_TTL_SECONDS: int = int(os.getenv("PROOF_CACHE_TTL_SECONDS", "300"))

#: Redis key prefix for proof validation cache entries.
_PROOF_CACHE_PREFIX: str = "stellarflow:zk:proof:"

#: Maximum proof byte length accepted for Groth16 (288 bytes typical).
_MAX_GROTH16_PROOF_BYTES: int = 4096

#: Maximum number of public inputs accepted.
_MAX_PUBLIC_INPUTS: int = 64

#: Maximum length of each public input string.
_MAX_PUBLIC_INPUT_LENGTH: int = 1024

# ---------------------------------------------------------------------------
# Module-level singletons (lazy-initialised via executor_pool)
# ---------------------------------------------------------------------------

# Legacy globals kept for backward-compatibility with existing tests / callers.
_process_pool: Optional[ProcessPoolExecutor] = None

# L1 cache: {proof_hash: ProofValidationResult}
_l1_cache: Dict[str, Any] = {}

# Lazy Redis client (populated on first use)
_redis_client: Any = None


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class ProofValidationResult:
    """Immutable validation outcome for a single proof payload."""

    valid: bool
    proof_hash: str
    verification_time_ms: float
    cached: bool
    error: Optional[str] = None
    contract_simulation_ready: bool = False
    public_inputs_count: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "valid": self.valid,
            "proofHash": self.proof_hash,
            "verificationTimeMs": self.verification_time_ms,
            "cached": self.cached,
            "error": self.error,
            "contractSimulationReady": self.contract_simulation_ready,
            "publicInputsCount": self.public_inputs_count,
        }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _compute_proof_hash(proof_hex: str, public_inputs: List[str]) -> str:
    """Deterministic SHA-256 digest used as the cache key."""
    payload = proof_hex.encode() + b"|" + "|".join(public_inputs).encode()
    return hashlib.sha256(payload).hexdigest()


def _get_redis_client() -> Any:
    """Lazily initialise and return the async Redis client."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client

    try:
        import redis.asyncio as aioredis

        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
        _redis_client = aioredis.from_url(
            redis_url,
            decode_responses=True,
            socket_connect_timeout=3,
            socket_timeout=3,
            retry_on_timeout=True,
        )
        log.info(
            "proof_engine.redis.initialised",
            component="ProofEngine",
            redis_url=redis_url,
        )
    except ImportError:
        log.warning(
            "proof_engine.redis.not_installed",
            component="ProofEngine",
        )
    except Exception as exc:
        log.warning(
            "proof_engine.redis.init_failed",
            component="ProofEngine",
            error=str(exc),
        )

    return _redis_client


def _validate_proof_structure(
    proof_hex: str,
    public_inputs: List[str],
    proof_scheme: str,
) -> Optional[str]:
    """Validate proof structure before passing parameters to contract simulation.

    Returns ``None`` on success or an error string on failure.
    """
    if not proof_hex:
        return "proof_hex is empty"

    if len(proof_hex) % 2 != 0:
        return "proof_hex length is odd — must be even for hex encoding"

    proof_bytes = len(proof_hex) // 2
    if proof_bytes > _MAX_GROTH16_PROOF_BYTES:
        return (
            f"proof exceeds maximum size of {_MAX_GROTH16_PROOF_BYTES} bytes "
            f"(got {proof_bytes})"
        )

    if not public_inputs:
        return "public_inputs must contain at least one element"

    if len(public_inputs) > _MAX_PUBLIC_INPUTS:
        return (
            f"public_inputs contains {len(public_inputs)} items, "
            f"maximum is {_MAX_PUBLIC_INPUTS}"
        )

    for idx, inp in enumerate(public_inputs):
        if len(inp) > _MAX_PUBLIC_INPUT_LENGTH:
            return (
                f"public_inputs[{idx}] exceeds {_MAX_PUBLIC_INPUT_LENGTH} characters"
            )

    if proof_scheme not in {"groth16", "plonk", "marlin", "flonk"}:
        return f"unsupported proof scheme: {proof_scheme}"

    return None


def _validate_contract_simulation_params(
    contract_params: Dict[str, Any],
) -> Optional[str]:
    """Validate contract simulation parameters structure.

    Ensures parameters are well-formed before they are passed to the
    Soroban contract simulation layer.
    """
    if not contract_params:
        return "contract_params must not be empty"

    required_keys = {"contract_id", "function_name", "source_account"}
    missing = required_keys - set(contract_params.keys())
    if missing:
        return f"contract_params missing required keys: {', '.join(sorted(missing))}"

    if not isinstance(contract_params.get("contract_id"), str):
        return "contract_params.contract_id must be a string"

    if not isinstance(contract_params.get("function_name"), str):
        return "contract_params.function_name must be a string"

    if not isinstance(contract_params.get("source_account"), str):
        return "contract_params.source_account must be a string"

    args = contract_params.get("args")
    if args is not None and not isinstance(args, list):
        return "contract_params.args must be a list when provided"

    return None


def _cpu_intensive_verify(proof_hex: str, public_inputs: List[str]) -> bool:
    """CPU-intensive proof verification executed inside a worker process.

    This simulates the elliptic-curve pairing checks that dominate real
    ZK proof verification time.  In production this would call into a
    native ZK library (e.g. bellman, arkworks-ffi, or snarkjs via subprocess).

    The loop is intentionally heavy to demonstrate offloading value.
    """
    try:
        proof_bytes = bytes.fromhex(proof_hex)
    except ValueError:
        return False

    accumulator = 0
    for i in range(proof_bytes[0] + 1):
        chunk = public_inputs[i % len(public_inputs)] if public_inputs else ""
        digest = hashlib.sha256(
            proof_bytes + chunk.encode() + i.to_bytes(4, "big")
        ).digest()
        accumulator = (accumulator + int.from_bytes(digest[:8], "big")) % (
            2**63
        )

    # A real verifier would return True/False based on pairing checks.
    # We derive a deterministic validity from the accumulator so that
    # identical inputs always produce the same result.
    return accumulator % 7 != 0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_process_pool() -> ProcessPoolExecutor:
    """Return (or lazily create) the module-level process pool.

    Delegates to :func:`app.services.executor_pool.get_heavy_pool` so that
    pool lifecycle is managed centrally.
    """
    global _process_pool
    if _process_pool is None:
        _process_pool = get_heavy_pool()
        log.info(
            "proof_engine.process_pool.initialised",
            component="ProofEngine",
            workers=PROOF_PROCESS_POOL_WORKERS,
        )
    return _process_pool


async def verify_proof_async(
    proof_hex: str,
    public_inputs: List[str],
    contract_params: Optional[Dict[str, Any]] = None,
    proof_scheme: str = "groth16",
    simulate_contract: bool = False,
) -> ProofValidationResult:
    """Verify a shielded transaction proof asynchronously.

    This coroutine is safe to call from the FastAPI event loop.  Heavy CPU
    work is offloaded to the ``ProcessPoolExecutor``.

    Parameters
    ----------
    proof_hex:
        Hex-encoded ZK proof bytes.
    public_inputs:
        Public inputs to the proof.
    contract_params:
        Optional Soroban contract simulation parameters.
    proof_scheme:
        Proof system scheme (``groth16``, ``plonk``, ``marlin``, ``flonk``).
    simulate_contract:
        If ``True``, validate that contract simulation parameters are ready.

    Returns
    -------
    ProofValidationResult
        Structured result including validity, timing, and cache status.
    """
    start = time.monotonic()

    # 1. Structure validation (cheap, synchronous)
    structure_error = _validate_proof_structure(proof_hex, public_inputs, proof_scheme)
    if structure_error:
        elapsed_ms = (time.monotonic() - start) * 1000
        return ProofValidationResult(
            valid=False,
            proof_hash="",
            verification_time_ms=elapsed_ms,
            cached=False,
            error=f"Structure validation failed: {structure_error}",
        )

    # 2. Contract simulation guard (cheap, synchronous)
    if simulate_contract and contract_params:
        contract_error = _validate_contract_simulation_params(contract_params)
        if contract_error:
            elapsed_ms = (time.monotonic() - start) * 1000
            return ProofValidationResult(
                valid=False,
                proof_hash="",
                verification_time_ms=elapsed_ms,
                cached=False,
                error=f"Contract simulation validation failed: {contract_error}",
            )

    # 3. Compute cache key
    proof_hash = _compute_proof_hash(proof_hex, public_inputs)

    # 4. L1 cache hit (nanosecond lookup)
    if proof_hash in _l1_cache:
        cached = _l1_cache[proof_hash]
        elapsed_ms = (time.monotonic() - start) * 1000
        log.debug(
            "proof_engine.cache.l1_hit",
            component="ProofEngine",
            proof_hash_prefix=proof_hash[:16],
        )
        return ProofValidationResult(
            valid=cached.valid,
            proof_hash=proof_hash,
            verification_time_ms=elapsed_ms,
            cached=True,
            error=cached.error,
            contract_simulation_ready=cached.contract_simulation_ready,
            public_inputs_count=cached.public_inputs_count,
        )

    # 5. L2 cache hit (Redis, ~sub-millisecond)
    redis = _get_redis_client()
    if redis is not None:
        try:
            import json

            raw = await redis.get(f"{_PROOF_CACHE_PREFIX}{proof_hash}")
            if raw:
                data = json.loads(raw)
                _l1_cache[proof_hash] = ProofValidationResult(**data)
                elapsed_ms = (time.monotonic() - start) * 1000
                log.debug(
            "proof_engine.cache.l2_hit",
            component="ProofEngine",
            proof_hash_prefix=proof_hash[:16],
        )
                return ProofValidationResult(
                    valid=data["valid"],
                    proof_hash=proof_hash,
                    verification_time_ms=elapsed_ms,
                    cached=True,
                    error=data.get("error"),
                    contract_simulation_ready=data.get("contract_simulation_ready", False),
                    public_inputs_count=data.get("public_inputs_count", 0),
                )
        except Exception as exc:
            log.warning(
                "proof_engine.cache.l2_lookup_failed",
                component="ProofEngine",
                error=str(exc),
            )

    # 6. Offload to process pool (expensive, CPU-bound)
    pool = get_process_pool()
    loop_start = time.monotonic()
    try:
        loop = asyncio.get_running_loop()
        valid = await loop.run_in_executor(
            pool, _cpu_intensive_verify, proof_hex, public_inputs
        )
    except Exception as exc:
        elapsed_ms = (time.monotonic() - start) * 1000
        log.exception(
            "proof_engine.verification.failed",
            component="ProofEngine",
            error=str(exc),
        )
        return ProofValidationResult(
            valid=False,
            proof_hash=proof_hash,
            verification_time_ms=elapsed_ms,
            cached=False,
            error=str(exc),
        )

    elapsed_ms = (time.monotonic() - start) * 1000
    pool_time_ms = (time.monotonic() - loop_start) * 1000

    # Track event-loop scheduling overhead (time spent dispatching to pool).
    # With ``run_in_executor`` the event loop should only be blocked for
    # a handful of microseconds while the Future is created.
    if pool_time_ms > 5.0:
        log.warning(
            "proof_engine.pool_dispatch.slow",
            component="ProofEngine",
            pool_dispatch_ms=round(pool_time_ms, 3),
            proof_hash_prefix=proof_hash[:16],
        )

    # 7. Build result
    contract_sim_ready = False
    if valid and simulate_contract and contract_params:
        contract_sim_ready = True

    result = ProofValidationResult(
        valid=valid,
        proof_hash=proof_hash,
        verification_time_ms=elapsed_ms,
        cached=False,
        contract_simulation_ready=contract_sim_ready,
        public_inputs_count=len(public_inputs),
    )

    # 8. Populate both cache tiers
    _l1_cache[proof_hash] = result

    if redis is not None:
        try:
            import json

            await redis.setEx(
                f"{_PROOF_CACHE_PREFIX}{proof_hash}",
                PROOF_CACHE_TTL_SECONDS,
                json.dumps(result.to_dict()),
            )
        except Exception as exc:
            log.warning(
                "proof_engine.cache.l2_write_failed",
                component="ProofEngine",
                error=str(exc),
            )

    log.debug(
        "proof_engine.verification.completed",
        component="ProofEngine",
        proof_hash_prefix=proof_hash[:16],
        elapsed_ms=round(elapsed_ms, 1),
        pool_ms=round(pool_time_ms, 1),
        valid=valid,
    )

    return result


async def verify_proof_batch(
    requests: List[Dict[str, Any]],
) -> List[ProofValidationResult]:
    """Verify multiple proof payloads concurrently using the process pool.

    Submits all payloads simultaneously and collects results as they complete.
    """
    if not requests:
        return []

    futures = []
    pool = get_process_pool()

    for req in requests:
        proof_hex = req.get("proof_hex", "")
        public_inputs = req.get("public_inputs", [])
        contract_params = req.get("contract_params")
        proof_scheme = req.get("proof_scheme", "groth16")
        simulate_contract = req.get("simulate_contract", False)

        # Lightweight validation + cache lookup is still done per-request
        # in the calling coroutine; the pool only receives the CPU-heavy call.
        structure_error = _validate_proof_structure(
            proof_hex, public_inputs, proof_scheme
        )
        if structure_error:
            futures.append(
                {
                    "valid": False,
                    "proof_hash": "",
                    "verification_time_ms": 0.0,
                    "cached": False,
                    "error": f"Structure validation failed: {structure_error}",
                }
            )
            continue

        proof_hash = _compute_proof_hash(proof_hex, public_inputs)

        # L1 cache
        if proof_hash in _l1_cache:
            cached = _l1_cache[proof_hash]
            futures.append(
                {
                    "valid": cached.valid,
                    "proof_hash": proof_hash,
                    "verification_time_ms": 0.0,
                    "cached": True,
                    "error": cached.error,
                }
            )
            continue

        # Submit to pool
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(
            pool, _cpu_intensive_verify, proof_hex, public_inputs
        )
        futures.append(
            {
                "future": future,
                "proof_hex": proof_hex,
                "public_inputs": public_inputs,
                "proof_hash": proof_hash,
                "contract_params": contract_params,
                "simulate_contract": simulate_contract,
            }
        )

    # Collect pool results
    results: List[ProofValidationResult] = []
    for item in futures:
        if "future" not in item:
            results.append(ProofValidationResult(**item))
            continue

        start = time.monotonic()
        try:
            valid = await item["future"]
        except Exception as exc:
            results.append(
                ProofValidationResult(
                    valid=False,
                    proof_hash=item["proof_hash"],
                    verification_time_ms=(time.monotonic() - start) * 1000,
                    cached=False,
                    error=str(exc),
                )
            )
            continue

        elapsed_ms = (time.monotonic() - start) * 1000
        contract_sim_ready = False
        if valid and item.get("simulate_contract") and item.get("contract_params"):
            contract_sim_ready = True

        result = ProofValidationResult(
            valid=valid,
            proof_hash=item["proof_hash"],
            verification_time_ms=elapsed_ms,
            cached=False,
            contract_simulation_ready=contract_sim_ready,
            public_inputs_count=len(item["public_inputs"]),
        )
        _l1_cache[item["proof_hash"]] = result

        redis = _get_redis_client()
        if redis is not None:
            try:
                import json

                await redis.setEx(
                    f"{_PROOF_CACHE_PREFIX}{item['proof_hash']}",
                    PROOF_CACHE_TTL_SECONDS,
                    json.dumps(result.to_dict()),
                )
            except Exception:
                pass

        results.append(result)

    return results


def shutdown_process_pool() -> None:
    """Cleanly shut down the process pool.  Intended for graceful shutdown.

    Delegates to :func:`app.services.executor_pool.shutdown_pools` so that
    both heavy and light pools are torn down together.
    """
    global _process_pool
    shutdown_pools()
    _process_pool = None
    log.info("proof_engine.process_pool.cleared", component="ProofEngine")


__all__ = [
    "ProofValidationResult",
    "get_process_pool",
    "verify_proof_async",
    "verify_proof_batch",
    "shutdown_process_pool",
    "PROOF_PROCESS_POOL_WORKERS",
    "PROOF_CACHE_TTL_SECONDS",
]
