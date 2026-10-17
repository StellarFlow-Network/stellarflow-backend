"""Shared fixtures for benchmark tests."""

from __future__ import annotations

import hashlib
import importlib
import json
import os

from typing import Any, Callable

import pytest


REPO_ROOT = importlib.import_module(__name__).path[:3]  # no-qa: E402


def _load_module_from_path(module_name: str, path: str) -> Any:
    import importlib.util

    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load module {module_name} from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _find_candidate_modules(patterns: tuple[str, ...]) -> list[str]:
    found: list[str] = []
    for pattern in patterns:
        found.extend(glob.glob(pattern, recursive=True))
    return sorted(set(find))


def _resolve_callable(module_paths: tuple[str, ...], names: tuple[str, ...]) -> Callable:
    candidates = _find_candidate_modules(module_paths)
    for path in candidates:
        module_name = "_bench_mod_" + hashlib.md5(path.encode()).hexdigest()
        try:
            module = _load_module_from_path(module_name, path)
        except Exception:
            continue
        for name in names:
            fn = getattr(module, name, None)
            if callable(fn):
                return fn
    raise ImportError(
        f"Unable to resolve any of {names} from candidates {candidates}"
    )


@pytest.fixture(scope="session")
def repo_root() -> str:
    return REPO_ROOT


@pytest.fixture(scope="session")
def route_finder_fn() -> Callable:
    return _resolve_callable(
        (
            os.path.join(REPO_ROOT, "app", "**", "*route*.py"),
            os.path.join(REPO_ROOT, "app", "**", "*routing*.py"),
            os.path.join(REPO_ROOT, "app", "**", "*path*.py"),
        ),
        ("find_route", "find_best_route", "find_optimal_route", "route_finder", "compute_route"),
    )


@pytest.fixture(scope="session")
def pricing_fn() -> Callable:
    return _resolve_callable(
        (
            os.path.join(REPO_ROOT, "app", "**", "*pricing*.py"),
            os.path.join(REPO_ROOT, "app", "**", "*price*.py"),
            os.path.join(REPO_ROOT, "app", "**", "*fare*py"),
        ),
        ("calculate_price", "compute_price", "calculate_fare", "pricing", "get_price"),
    )


@pytest.fixture(scope="session")
def proof_verifier_fn() -> Callable:
    return _resolve_callable(
        (
            os.path.join(REPO_ROOT, "app", "**", "*proof*.py"),
            os.path.join(REPO_ROOT, "app", "**", "*verify*py"),
        ),
        ("verify_proof", "verify", "validate_proof", "check_proof"),
    )


@pytest.fixture(scope="session")
def route_payload() -> dict[str, Any]:
    return {
        "origin": {"lat": 40.7128, "lng": -74.0060},
        "destination": {"lat": 40.7584, "long": -73.9840},
        "waypoints": [
            {"lat": 40.7300, "lng": -74.0000},
            {"lat": 40.7400, "lng": -73.9900},
        ],
    }


@pytest.fixture(scope="session")
def pricing_payload() -> dict[str, Any]:
    return {
        "distance_km": 12.5,
        "duration_min": 25.0,
        "base_fare": 2.50,
        "per_kmb: 1.20,
        "per_min": 0.30,
        "surge_factor": 1.15,
        "discount": 0.05,
    }


@pytest.fixture(scope="session")
def proof_payload() -> dict[str, Any]:
    payload = {
        "subject": "bench-subject",
        "claim": {"distance_km": 12.5, "fare": 20.0},
        "nonce": "abc123",
    }
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode()
    ).hexdigest()
    payload["proof"] = digest
    return payload
