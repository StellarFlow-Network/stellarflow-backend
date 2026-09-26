"""Tests for scripts/coverage_report.py — the PR coverage gate (Issue #1035)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "coverage_report.py"
SPEC = importlib.util.spec_from_file_location("coverage_report_module", SCRIPT_PATH)
report = importlib.util.module_from_spec(SPEC)
assert SPEC is not None and SPEC.loader is not None
sys.modules[SPEC.name] = report  # dataclasses resolve annotations via sys.modules
SPEC.loader.exec_module(report)


def _xml(files: dict) -> str:
    """Build a minimal Cobertura report.

    ``files`` maps filename -> list of (hits, branch_condition_or_None).
    """
    classes = []
    for filename, lines in files.items():
        rendered = []
        for number, (hits, condition) in enumerate(lines, start=1):
            if condition:
                rendered.append(
                    f'<line number="{number}" hits="{hits}" branch="true" '
                    f'condition-coverage="{condition}"/>'
                )
            else:
                rendered.append(f'<line number="{number}" hits="{hits}"/>')
        classes.append(
            f'<class name="{filename}" filename="{filename}"><lines>'
            + "".join(rendered)
            + "</lines></class>"
        )
    return (
        '<?xml version="1.0" ?><coverage>'
        "<sources><source>/repo/app</source></sources>"
        '<packages><package name="."><classes>'
        + "".join(classes)
        + "</classes></package></packages></coverage>"
    )


def _write(tmp_path: Path, name: str, files: dict) -> Path:
    path = tmp_path / name
    path.write_text(_xml(files))
    return path


def test_parse_counts_lines_and_branches(tmp_path):
    path = _write(
        tmp_path,
        "coverage.xml",
        {
            "a.py": [(1, None), (0, None), (3, "50% (1/2)")],
            "b.py": [(2, None)],
        },
    )
    data = report.parse_coverage_xml(path)

    # a.py: 3 lines (2 hit) + 2 branches (1 hit) = 3/5 ; b.py: 1/1
    assert data.files["app/a.py"] == report.Counts(3, 5)
    assert data.files["app/b.py"] == report.Counts(1, 1)
    assert data.total == report.Counts(4, 6)
    assert data.total.percent == pytest.approx(66.6667, rel=1e-3)


def test_empty_scope_counts_as_fully_covered():
    assert report.Counts(0, 0).percent == 100.0


def test_report_marks_pass_and_shows_positive_delta(tmp_path):
    head = report.parse_coverage_xml(_write(tmp_path, "h.xml", {"a.py": [(1, None)] * 9 + [(0, None)]}))
    base = report.parse_coverage_xml(_write(tmp_path, "b.xml", {"a.py": [(1, None)] * 8 + [(0, None)] * 2}))

    text = report.build_report(head, base, threshold=80.0, changed_files=["app/a.py"])

    assert report.COMMENT_MARKER in text
    assert "**Total coverage: 90.00%**" in text
    assert "✅ passed" in text
    assert "80.00% → this PR: 90.00%" in text
    assert "🟢 +10.00" in text
    assert "| `app/a.py` | 90.00% |" in text


def test_report_marks_failure_and_regression(tmp_path):
    head = report.parse_coverage_xml(_write(tmp_path, "h.xml", {"a.py": [(1, None)] * 7 + [(0, None)] * 3}))
    base = report.parse_coverage_xml(_write(tmp_path, "b.xml", {"a.py": [(1, None)] * 9 + [(0, None)]}))

    text = report.build_report(head, base, threshold=80.0)

    assert "❌ failed" in text
    assert "10.00 percentage points below" in text
    assert "🔴 -20.00" in text
    # Untouched-by-PR file still listed because its coverage moved.
    assert "`app/a.py`" in text


def test_report_without_base_skips_delta(tmp_path):
    head = report.parse_coverage_xml(_write(tmp_path, "h.xml", {"a.py": [(1, None)]}))

    text = report.build_report(head, None, threshold=80.0)

    assert "delta not computed" in text
    assert "Δ vs base" not in text  # no table when nothing changed / no base


def test_new_file_has_no_delta_but_is_listed_when_changed(tmp_path):
    head = report.parse_coverage_xml(
        _write(tmp_path, "h.xml", {"a.py": [(1, None)], "new.py": [(1, None), (0, None)]})
    )
    base = report.parse_coverage_xml(_write(tmp_path, "b.xml", {"a.py": [(1, None)]}))

    text = report.build_report(head, base, threshold=80.0, changed_files=["app/new.py"])

    assert "| `app/new.py` | 50.00% |" in text
    assert "`app/a.py`" not in text  # unchanged and untouched


def test_file_table_is_capped(tmp_path):
    many = {f"m{i}.py": [(0, None)] for i in range(report.MAX_FILE_ROWS + 5)}
    head = report.parse_coverage_xml(_write(tmp_path, "h.xml", many))

    text = report.build_report(head, None, 80.0, changed_files=[f"app/{n}" for n in many])

    assert "…and 5 more" in text


def test_main_exit_codes_and_output_file(tmp_path, capsys):
    passing = _write(tmp_path, "pass.xml", {"a.py": [(1, None)] * 9 + [(0, None)]})
    failing = _write(tmp_path, "fail.xml", {"a.py": [(1, None)] * 5 + [(0, None)] * 5})
    out = tmp_path / "summary.md"

    assert report.main(["--head", str(passing), "--threshold", "80", "--output", str(out)]) == 0
    assert report.COMMENT_MARKER in out.read_text()

    assert report.main(["--head", str(failing), "--threshold", "80"]) == 1
    assert "below the required 80%" in capsys.readouterr().err

    # Exactly at the threshold passes.
    exact = _write(tmp_path, "exact.xml", {"a.py": [(1, None)] * 4 + [(0, None)]})
    assert report.main(["--head", str(exact), "--threshold", "80"]) == 0


def test_main_missing_head_report_is_an_error(tmp_path, capsys):
    assert report.main(["--head", str(tmp_path / "nope.xml")]) == 2
    assert "not found" in capsys.readouterr().err


def test_main_tolerates_corrupt_base_report(tmp_path, capsys):
    head = _write(tmp_path, "h.xml", {"a.py": [(1, None)]})
    base = tmp_path / "base.xml"
    base.write_text("<coverage><not-closed>")

    assert report.main(["--head", str(head), "--base", str(base)]) == 0
    assert "skipping delta" in capsys.readouterr().err


def test_changed_files_list_is_read(tmp_path):
    listing = tmp_path / "changed.txt"
    listing.write_text("app/a.py\n\n  app/b.py \n")

    assert report._read_changed_files(listing) == ["app/a.py", "app/b.py"]
    assert report._read_changed_files(None) == []
    assert report._read_changed_files(tmp_path / "missing.txt") == []
