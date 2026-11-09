"""Page indexing binds validation to the same bytes recorded by its digest."""

from pathlib import Path

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.docx import pipeline

ROOT = Path(__file__).resolve().parents[2]
PAGE = ROOT / "reports/phase0/fixtures/s1-figures-tables/pages-150dpi/page-1.png"


def test_page_mutation_after_png_inspection_is_refused(tmp_path, monkeypatch):
    pages = tmp_path / "pages"
    pages.mkdir()
    page = pages / "page-1.png"
    page.write_bytes(PAGE.read_bytes())
    real_inspect = pipeline.inspect_png

    def change_after_inspection(content):
        dimensions = real_inspect(content)
        page.write_bytes(b"not-png")
        return dimensions

    monkeypatch.setattr(pipeline, "inspect_png", change_after_inspection)
    with pytest.raises(pipeline.S1PipelineError, match="changed during inspection"):
        pipeline._build_page_evidence_index(pages, tmp_path, None)


def test_page_index_hash_identifies_the_validated_capture(tmp_path, monkeypatch):
    pages = tmp_path / "pages"
    pages.mkdir()
    page = pages / "page-1.png"
    content = PAGE.read_bytes()
    page.write_bytes(content)
    real_hash = pipeline.sha256_file
    calls = []

    def record_verification(path):
        calls.append(path)
        return real_hash(path)

    monkeypatch.setattr(pipeline, "sha256_file", record_verification)
    index = pipeline._build_page_evidence_index(pages, tmp_path, None)
    assert index["pages"][0]["sha256"] == sha256_bytes(content)
    assert calls == [page]


@pytest.mark.parametrize("field", ["locator", "range_type"])
def test_structure_report_requires_explicit_read_range_identity(field: str) -> None:
    report = {
        "actual_read_ranges": [
            {"locator": "document.xml", "range_type": "document", "parse_status": "parsed"}
        ]
    }
    report["actual_read_ranges"][0].pop(field)
    with pytest.raises(pipeline.S1PipelineError, match="without"):
        pipeline._read_ranges_from_report(report, "a" * 64)


def test_structure_report_rejects_non_text_read_range_status() -> None:
    report = {
        "actual_read_ranges": [
            {"locator": "document.xml", "range_type": "document", "parse_status": []}
        ]
    }
    with pytest.raises(pipeline.S1PipelineError, match="invalid read-range status"):
        pipeline._read_ranges_from_report(report, "a" * 64)
