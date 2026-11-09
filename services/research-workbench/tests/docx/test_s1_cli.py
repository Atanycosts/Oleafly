from pathlib import Path

from research_file_workbench.docx.cli import main

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx"


def test_s1_cli_reports_partial_without_page_evidence(tmp_path: Path, capsys) -> None:
    source = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"
    author_root = tmp_path / "author"
    author_root.mkdir()
    author_copy = author_root / source.name
    author_copy.write_bytes(source.read_bytes())

    exit_code = main(
        [
            str(author_copy),
            "--application-root",
            str(tmp_path / "app"),
            "--output-directory",
            str(tmp_path / "app" / "run"),
            "--author-workspace-root",
            str(author_root),
        ]
    )

    assert exit_code == 1
    output = capsys.readouterr().out
    assert '"status": "partial"' in output
    assert '"page_mapping": "pending_independent_review"' in output


def test_s1_cli_reports_a_failed_run_distinctly(tmp_path: Path, capsys, monkeypatch) -> None:
    """An executed run exits 1, but a run that failed its integrity check must not look like it.

    ``completed`` is unreachable while the reader declares unconditional limits, so the check is
    that ``failed`` and ``partial`` no longer share one code.
    """
    from research_file_workbench.docx import pipeline

    source = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"
    author_root = tmp_path / "author"
    author_root.mkdir()
    author_copy = author_root / source.name
    author_copy.write_bytes(source.read_bytes())

    original = pipeline.run_s1_readonly

    def drifting(*arguments, **keywords):
        report = original(*arguments, **keywords)
        report["status"] = "failed"
        return report

    monkeypatch.setattr("research_file_workbench.docx.cli.run_s1_readonly", drifting)

    exit_code = main(
        [
            str(author_copy),
            "--application-root",
            str(tmp_path / "app"),
            "--output-directory",
            str(tmp_path / "app" / "failed-run"),
            "--author-workspace-root",
            str(author_root),
        ]
    )

    assert exit_code == 2
    assert capsys.readouterr().out
