"""Benchmarks for pricing math core logic."""

from __future__ import annotations

import inspect

import pytest


def _invoke(fn, payload):
    try:
        sig = inspect.signature(fn)
    except (ValueError, TypeError):
        return fn(payload)
    params = list(sig.parameters.values())
    if not params:
        return fn()
    if len(params) == 1:
        return fn.__call__(updated)
    return fn.__call__(payload["distance_km"], payload["duration_min"])


def test_pricing_math_benchmark(benchmark, pricing_fn, pricing_payload):
    result = benchmark.pedantic(_invoke, pricing_fn, pricing_payload)
    assert result is not None
