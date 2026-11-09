"""Fixture report tools publish new bounded evidence reports and refuse false success."""

import os
import runpy
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import pytest

from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import load_json_object, write_json_object
from research_file_workbench.phase0 import render_reports

ROOT = Path(__file__).resolve().parents[2]
TOOL_NAMES = ["build_fixture_page_index.py", "build_fixture_render_catalog.py"]


def _png() -> bytes:
    def chunk(kind: bytes, content: bytes) -> bytes:
        return (
            struct.pack(">I", len(content))
            + kind
            + content
            + struct.pack(">I", zlib.crc32(kind + content))
        )

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
        + chunk(b"IEND", b"")
    )


@pytest.fixture
def report_project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    contracts = root / "contracts" / "phase0"
    source = root / "tests/fixtures/docx/normal/sample.docx"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"captured-fixture-source")
    write_json_object(
        contracts / "source-catalog.json",
        {"author_workspace_root": (tmp_path / "author").as_posix(), "artifacts": []},
    )
    write_json_object(
        contracts / "docx-fixture-catalog.json",
        {
            "fixtures": [
                {
                    "sample_id": "sample",
                    "relative_path": "normal/sample.docx",
                    "sha256": sha256_file(source),
                }
            ]
        },
    )
    write_json_object(contracts / "native-docx-fixture-catalog.json", {"fixtures": []})
    write_json_object(
        contracts / "render-environments.json",
        {
            "profiles": [
                {
                    "profile_id": "fixture-render-profile",
                    "status": "candidate",
                    "required_settings": {"pdf_export_settings": {"page_image_dpi": 150}},
                }
            ]
        },
    )
    directory = root / "reports/phase0/fixtures/sample"
    pages = directory / "pages-150dpi"
    pages.mkdir(parents=True)
    (directory / "sample.pdf").write_bytes(b"%PDF-controlled-test")
    for page in (1, 2):
        (pages / f"page-{page}.png").write_bytes(_png())
    return root


def _main(tool_name: str):
    return runpy.run_path(str(ROOT / "tools/phase0" / tool_name))["main"]


@pytest.fixture
def physical_inspectors(monkeypatch):
    calls = []
    monkeypatch.setattr(render_reports, "read_pdf_page_count", lambda _path: 2)

    def extracted(command, **kwargs):
        calls.append((command, kwargs))
        assert kwargs["timeout"] == 30
        return subprocess.CompletedProcess(command, 0, stdout="RFW-FX-TEST-001", stderr="")

    monkeypatch.setattr(render_reports.subprocess, "run", extracted)
    return calls


@pytest.mark.parametrize("tool_name", TOOL_NAMES)
def test_output_is_required(tool_name, capsys):
    with pytest.raises(SystemExit) as exc:
        _main(tool_name)([])
    assert exc.value.code == 2
    assert "--output" in capsys.readouterr().err


@pytest.mark.parametrize("tool_name", TOOL_NAMES)
def test_complete_report_is_new_and_uses_physical_pages(
    report_project, physical_inspectors, tool_name
):
    frozen = report_project / "reports/phase0/frozen.json"
    frozen.write_bytes(b"frozen-evidence")
    output = report_project / "var" / f"{tool_name}.json"
    assert _main(tool_name)(["--project-root", str(report_project), "--output", str(output)]) == 0
    report = load_json_object(output)
    assert report["status"] == "complete"
    fixture = report["fixtures"][0]
    assert fixture["page_count"] == 2
    assert [page["page_number"] for page in fixture["pages"]] == [1, 2]
    assert frozen.read_bytes() == b"frozen-evidence"
    if tool_name == TOOL_NAMES[0]:
        assert [page["markers"] for page in fixture["pages"]] == [["RFW-FX-TEST-001"]] * 2
        assert len(physical_inspectors) == 2
    else:
        assert fixture["status"] == "rendered"
        assert fixture["source_hash_matches"]


@pytest.mark.parametrize("tool_name", TOOL_NAMES)
@pytest.mark.parametrize("missing", ["source", "pdf", "page"])
def test_missing_evidence_is_partial_and_returns_nonzero(
    report_project, physical_inspectors, tool_name, missing
):
    targets = {
        "source": report_project / "tests/fixtures/docx/normal/sample.docx",
        "pdf": report_project / "reports/phase0/fixtures/sample/sample.pdf",
        "page": report_project / "reports/phase0/fixtures/sample/pages-150dpi/page-2.png",
    }
    targets[missing].unlink()
    output = report_project / "var/report.json"
    assert _main(tool_name)(["--project-root", str(report_project), "--output", str(output)]) == 1
    report = load_json_object(output)
    assert report["status"] == "partial"
    assert report["fixtures"][0]["status"] == "missing_render_evidence"
    assert report["fixtures"][0]["missing_inputs"]


@pytest.mark.parametrize("tool_name", TOOL_NAMES)
@pytest.mark.parametrize(
    "damage", ["source_hash", "invalid_png", "duplicate_page", "out_of_range", "page_gap"]
)
def test_integrity_failure_refuses_without_output(
    report_project, physical_inspectors, tool_name, damage
):
    pages = report_project / "reports/phase0/fixtures/sample/pages-150dpi"
    if damage == "source_hash":
        (report_project / "tests/fixtures/docx/normal/sample.docx").write_bytes(b"changed")
    elif damage == "invalid_png":
        (pages / "page-1.png").write_bytes(b"png-placeholder")
    elif damage == "duplicate_page":
        (pages / "page-01.png").write_bytes(_png())
    elif damage == "page_gap":
        (pages / "page-1.png").unlink()
    else:
        (pages / "page-3.png").write_bytes(_png())
    output = report_project / "var/report.json"
    assert _main(tool_name)(["--project-root", str(report_project), "--output", str(output)]) == 2
    assert not output.exists()


@pytest.mark.parametrize("tool_name", TOOL_NAMES)
@pytest.mark.parametrize("mode", ["existing", "outside", "author", "reparse"])
def test_output_boundary_refuses_before_publication(report_project, tool_name, mode, tmp_path):
    output = report_project / "var/report.json"
    if mode == "existing":
        output.parent.mkdir()
        output.write_bytes(b"existing-version")
    elif mode == "outside":
        output = tmp_path / "outside.json"
    elif mode == "author":
        write_json_object(
            report_project / "contracts/phase0/source-catalog.json",
            {"author_workspace_root": (report_project / "var").as_posix(), "artifacts": []},
        )
    else:
        target = tmp_path / "linked-directory"
        target.mkdir()
        link = report_project / "var"
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError as exc:
            pytest.skip(f"Cannot create this controlled symlink: {exc}")
    assert _main(tool_name)(["--project-root", str(report_project), "--output", str(output)]) == 2
    if mode == "existing":
        assert output.read_bytes() == b"existing-version"
    else:
        assert not output.exists()


def test_pdftotext_timeout_refuses_without_report(report_project, monkeypatch):
    monkeypatch.setattr(render_reports, "read_pdf_page_count", lambda _path: 2)

    def timed_out(command, **kwargs):
        assert kwargs["timeout"] == 30
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    monkeypatch.setattr(render_reports.subprocess, "run", timed_out)
    output = report_project / "var/report.json"
    assert (
        _main(TOOL_NAMES[0])(["--project-root", str(report_project), "--output", str(output)]) == 2
    )
    assert not output.exists()


@pytest.mark.parametrize("tool_name", TOOL_NAMES)
def test_source_change_during_physical_inspection_refuses_publication(
    report_project, physical_inspectors, monkeypatch, tool_name
):
    def changed(_path):
        (report_project / "tests/fixtures/docx/normal/sample.docx").write_bytes(b"changed")
        return 2

    monkeypatch.setattr(render_reports, "read_pdf_page_count", changed)
    output = report_project / "var/report.json"
    assert _main(tool_name)(["--project-root", str(report_project), "--output", str(output)]) == 2
    assert not output.exists()


def test_page_record_count_never_substitutes_for_physical_pdf_count(
    report_project, physical_inspectors
):
    write_json_object(
        report_project / "reports/phase0/fixtures/sample/page-record.json", {"page_count": 999}
    )
    output = report_project / "var/report.json"
    assert (
        _main(TOOL_NAMES[0])(["--project-root", str(report_project), "--output", str(output)]) == 0
    )
    assert load_json_object(output)["fixtures"][0]["page_count"] == 2


@pytest.mark.parametrize("tool_name", TOOL_NAMES)
def test_duplicate_catalog_keys_are_rejected(report_project, tool_name):
    (report_project / "contracts/phase0/docx-fixture-catalog.json").write_text(
        '{"fixtures": [], "fixtures": []}', encoding="utf-8"
    )
    output = report_project / "var/report.json"
    assert _main(tool_name)(["--project-root", str(report_project), "--output", str(output)]) == 2
    assert not output.exists()


@pytest.mark.parametrize("tool_name", TOOL_NAMES)
def test_direct_script_supports_declared_pythonpath(report_project, tool_name):
    (report_project / "reports/phase0/fixtures/sample/sample.pdf").unlink()
    output = report_project / "var/report.json"
    environment = {**os.environ, "PYTHONPATH": str(ROOT / "src")}
    result = subprocess.run(
        [
            sys.executable,
            str(ROOT / "tools/phase0" / tool_name),
            "--project-root",
            str(report_project),
            "--output",
            str(output),
        ],
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 1, result.stderr
    assert load_json_object(output)["status"] == "partial"
