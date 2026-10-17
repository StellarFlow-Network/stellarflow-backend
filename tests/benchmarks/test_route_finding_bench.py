"""Benchmarks for route finding core logic."""

from __future__ import annotations

import inspect
import typing

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
        return fn.__call__(payload)
    return fn.__call__(payload["origin"], payload["destination"])


def test_route_finding_benchmark(benchmark, route_finder_fn, route_payload):
    result = benchmark.pedantic(_invoke, route_finder_fn, route_payload)
    assert result is not None
