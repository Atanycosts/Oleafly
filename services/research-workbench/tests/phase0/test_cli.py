from pathlib import Path

import pytest

from research_file_workbench.common.filesystem import PathBoundaryError
from research_file_workbench.phase0 import cli
from research_file_workbench.phase0.cli import main

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_build_reports_incomplete_returns_nonzero(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    report_path = tmp_path / "contract-validation.json"
    report_path.write_text('{"contract_valid":true,"phase0_complete":false}', encoding="utf-8")
    monkeypatch.setattr(
        cli, "build_phase0_reports", lambda root: {"contract-validation.json": report_path}
    )
    assert main(["--project-root", str(tmp_path), "build-reports"]) != 0


def test_fingerprint_rejects_output_in_scanned_root(tmp_path: Path) -> None:
    author_root = tmp_path / "author"
    author_root.mkdir()
    manuscript = author_root / "manuscript.docx"
    manuscript.write_bytes(b"source")

    with pytest.raises(PathBoundaryError):
        main(
            [
                "--project-root",
                str(PROJECT_ROOT),
                "fingerprint",
                str(author_root),
                str(manuscript),
            ]
        )

    assert manuscript.read_bytes() == b"source"


def test_fingerprint_writes_new_file_under_var(tmp_path: Path) -> None:
    author_root = tmp_path / "author"
    author_root.mkdir()
    (author_root / "source.txt").write_text("source", encoding="utf-8")
    output = PROJECT_ROOT / "var" / "test-fingerprint.json"
    output.unlink(missing_ok=True)
    try:
        result = main(
            [
                "--project-root",
                str(PROJECT_ROOT),
                "fingerprint",
                str(author_root),
                str(output),
            ]
        )
        assert result == 0
        assert output.is_file()
    finally:
        output.unlink(missing_ok=True)
