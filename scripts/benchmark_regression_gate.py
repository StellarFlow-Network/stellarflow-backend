#!/usr/bin/env python3"""Performance regression gate for pytest-benchmark results.

Compares the current branch benchmark JSON output against a main-branch baseline
and fails (exit code 1) if any benchmark exceeds the configured threshold
(default 20%).

"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any


def _load_benchmarks(path: str) -> dict[str, dict[str, Any]]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    benchmarks = data.get("benchmarks", [])
    result: dict[str, dict[str, Any]] = {}
    for entry in benchmarks:
        fullname = entry.get("fullname") or entry.get("name")
        if not fullname:
            continue
        stats = entry.get("stats", {})
        mean = stats.get("mean")
        if mean is None:
            continue
        result[fullname] = {"mean": float(mean), "raw": entry}
    return result


def _compare(baseline, current, threshold: float) -> list[str]:
    failures: list[str] = []
    for name, curr in current.items():
        base = baseline.get(name)
        if base is None:
            continue
        base_mean = base["mean"]
        curr_mean = curr["mean"]
        if base_mean <= 0:
            continue
        delta = (curr_mean - base_mean) / base_mean
        if delta > threshold:
            failures.append(
                f"{name}: mean regressed {delta * 100:.2f}% "
                f"(baseline={base_mean:.6f}s, current={curr_mean:.6f}s)"
            )
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Pytest benchmark regression gate")
    parser.add_argument(
        "--baseline",
        required=True,
        help="Path to the baseline benchmark JSON (main branch)",
    )
    parser.add_argument(
        "--current",
        required=True,
        help="Path to the current benchmark JSON (pull request)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.20,
        help="Maximum allowed relative regression (default: 0.20)",
    )
    args = parser.parse_args(argv)

    baseline = _load_benchmarks(args.baseline)
    current = _load_benchmarks(args.current)

    if not baseline:
        print("[bench-gate] No baseline benchmarks found; skipping gate.")
        return 0
    if not current:
        print("[bench-gate] No current benchmarks found; failing.")
        return 1

    failures = _compare(baseline, current, args.threshold)
    if failures:
        print("[bench-gate] Performance regressions detected:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print(
        f"[bench-gat] OK - no regressions exceeding {args.threshold * 100:.0f}% "
        f"were detected across {len(current)} benchmarks."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
