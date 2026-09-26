#!/usr/bin/env python3
"""Coverage gate + delta summary for pull-request CI (Issue #1035).

Reads the Cobertura ``coverage.xml`` produced by ``pytest --cov=app
--cov-report=xml`` for the pull-request head and, optionally, for the base
branch, then:

* prints a Markdown summary (total coverage, delta vs. base, per-file delta
  breakdown) that the workflow posts as a pull-request comment, and
* exits non-zero when total coverage is below the configured threshold.

The "total" mirrors coverage.py's own TOTAL (lines + branches combined) so the
number reported here always agrees with ``--cov-fail-under``.

Usage::

    python scripts/coverage_report.py --head coverage.xml \\
        [--base coverage-base.xml] [--threshold 80] \\
        [--changed-files changed.txt] [--output summary.md]
"""

from __future__ import annotations

import argparse
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional

DEFAULT_THRESHOLD = 80.0

# Hidden marker so the workflow can find and update its previous comment.
COMMENT_MARKER = "<!-- pytest-coverage-report -->"

# Cap the per-file table so the comment stays readable on large PRs.
MAX_FILE_ROWS = 25

# Deltas smaller than this (in percentage points) are treated as noise.
DELTA_EPSILON = 0.005


@dataclass(frozen=True)
class Counts:
    """Covered / total measurable units (lines + branches) for a scope."""

    covered: int
    total: int

    @property
    def percent(self) -> float:
        return 100.0 if self.total == 0 else self.covered * 100.0 / self.total


@dataclass(frozen=True)
class CoverageData:
    total: Counts
    files: Dict[str, Counts]


def _parse_branch_ratio(condition_coverage: Optional[str]) -> Counts:
    """Parse Cobertura ``condition-coverage="50% (1/2)"`` into counts."""
    if not condition_coverage or "(" not in condition_coverage:
        return Counts(0, 0)
    ratio = condition_coverage.rsplit("(", 1)[1].rstrip(")")
    covered, _, total = ratio.partition("/")
    return Counts(int(covered), int(total))


def parse_coverage_xml(path: Path) -> CoverageData:
    """Parse a coverage.py Cobertura report into total and per-file counts."""
    root = ET.parse(path).getroot()

    # coverage.py writes filenames relative to <source>; re-prefix the source
    # directory name (``app``) so rows read as repo-relative paths.
    source = root.findtext("sources/source") or ""
    prefix = Path(source).name if source else ""

    files: Dict[str, Counts] = {}
    for cls in root.iter("class"):
        filename = cls.get("filename", "")
        covered = total = 0
        for line in cls.iter("line"):
            total += 1
            if int(line.get("hits", "0")) > 0:
                covered += 1
            if line.get("branch") == "true":
                branches = _parse_branch_ratio(line.get("condition-coverage"))
                covered += branches.covered
                total += branches.total
        key = f"{prefix}/{filename}" if prefix else filename
        previous = files.get(key, Counts(0, 0))
        files[key] = Counts(previous.covered + covered, previous.total + total)

    total_counts = Counts(
        sum(c.covered for c in files.values()),
        sum(c.total for c in files.values()),
    )
    return CoverageData(total=total_counts, files=files)


def _fmt_pct(value: float) -> str:
    return f"{value:.2f}%"


def _fmt_delta(delta: float) -> str:
    if abs(delta) < DELTA_EPSILON:
        return "±0.00"
    icon = "🟢" if delta > 0 else "🔴"
    return f"{icon} {delta:+.2f}"


def build_report(
    head: CoverageData,
    base: Optional[CoverageData],
    threshold: float,
    changed_files: Optional[Iterable[str]] = None,
) -> str:
    """Render the Markdown summary posted as the PR comment."""
    passed = head.total.percent >= threshold
    status = "✅ passed" if passed else "❌ failed"

    lines: List[str] = [COMMENT_MARKER, "## 🧪 Test coverage report", ""]
    lines.append(
        f"**Total coverage: {_fmt_pct(head.total.percent)}** "
        f"(required: {threshold:g}%) — {status}"
    )

    if base is not None:
        delta = head.total.percent - base.total.percent
        lines.append(
            f"\nBase branch: {_fmt_pct(base.total.percent)} → "
            f"this PR: {_fmt_pct(head.total.percent)} ({_fmt_delta(delta)} pp)"
        )
    else:
        lines.append("\n_No base-branch coverage available; delta not computed._")

    if not passed:
        shortfall = threshold - head.total.percent
        lines.append(
            f"\n> Coverage is {shortfall:.2f} percentage points below the "
            f"{threshold:g}% minimum. Add tests for the new or changed code."
        )

    rows = _file_rows(head, base, set(changed_files or ()))
    if rows:
        lines += [
            "",
            "<details><summary>Per-file breakdown</summary>",
            "",
            "| File | Coverage | Δ vs base |",
            "| --- | ---: | ---: |",
        ]
        lines += rows[:MAX_FILE_ROWS]
        if len(rows) > MAX_FILE_ROWS:
            lines.append(f"| _…and {len(rows) - MAX_FILE_ROWS} more_ | | |")
        lines += ["", "</details>"]

    return "\n".join(lines) + "\n"


def _file_rows(
    head: CoverageData,
    base: Optional[CoverageData],
    changed: set,
) -> List[str]:
    """Rows for files touched by the PR or whose coverage moved vs. base."""
    interesting = []
    for name, counts in head.files.items():
        base_counts = base.files.get(name) if base else None
        if base_counts is None:
            delta = None if base is None else counts.percent  # new file
        else:
            delta = counts.percent - base_counts.percent
        moved = delta is not None and abs(delta) >= DELTA_EPSILON
        if name in changed or moved:
            interesting.append((name, counts, delta))

    # Biggest regressions first, so problems are at the top.
    interesting.sort(key=lambda item: (item[2] is None, item[2] or 0.0, item[0]))
    return [
        f"| `{name}` | {_fmt_pct(counts.percent)} | "
        f"{'n/a' if delta is None else _fmt_delta(delta)} |"
        for name, counts, delta in interesting
    ]


def _read_changed_files(path: Optional[Path]) -> List[str]:
    if path is None or not path.exists():
        return []
    return [ln.strip() for ln in path.read_text().splitlines() if ln.strip()]


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--head", type=Path, required=True, help="PR coverage.xml")
    parser.add_argument("--base", type=Path, help="base-branch coverage.xml")
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--changed-files", type=Path, help="newline list of PR files")
    parser.add_argument("--output", type=Path, help="write Markdown summary here")
    args = parser.parse_args(argv)

    if not args.head.exists():
        print(f"error: head coverage report not found: {args.head}", file=sys.stderr)
        return 2

    head = parse_coverage_xml(args.head)
    base: Optional[CoverageData] = None
    if args.base and args.base.exists():
        try:
            base = parse_coverage_xml(args.base)
        except ET.ParseError:
            print("warning: base coverage report unreadable; skipping delta", file=sys.stderr)

    report = build_report(
        head, base, args.threshold, _read_changed_files(args.changed_files)
    )
    if args.output:
        args.output.write_text(report)
    print(report)

    if head.total.percent < args.threshold:
        print(
            f"FAIL: total coverage {head.total.percent:.2f}% is below the "
            f"required {args.threshold:g}%",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
