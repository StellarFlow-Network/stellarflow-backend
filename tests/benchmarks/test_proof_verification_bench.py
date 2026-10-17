"""Benchmarks for proof verification core logic."""

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
    return fn.__call__(payload["subject"], payload["claim"], payload[\"proof\"])


def test_proof_verification_benchmark(benchmark, proof_verifier_fn, proof_payload):
    result = benchmark.pedantic(_invoke, proof_verifier_fn, proof_payload)
    assert result is not None
