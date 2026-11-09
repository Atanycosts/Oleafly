import subprocess
from pathlib import Path

import pytest

from research_file_workbench.common.pdf import PdfInspectionError, read_pdf_page_count


def test_physical_page_count_from_existing_fixture():
    root = Path(__file__).resolve().parents[2]
    pdf = root / "reports/phase0/fixtures/s1-figures-tables/s1-figures-tables.pdf"
    assert read_pdf_page_count(pdf) == 3


def test_inspector_failure_is_not_a_default_page_count(monkeypatch):
    def unavailable(*args, **kwargs):
        raise FileNotFoundError("pdfinfo missing")

    monkeypatch.setattr(subprocess, "run", unavailable)
    with pytest.raises(PdfInspectionError, match="Cannot verify"):
        read_pdf_page_count(Path("unused.pdf"))


@pytest.mark.parametrize("output", [b"Title: sample\n", b"Pages: 0\n", b"Pages: unknown\n"])
def test_missing_or_invalid_page_count_refuses(monkeypatch, output):
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, output, b""),
    )
    with pytest.raises(PdfInspectionError, match="positive page count"):
        read_pdf_page_count(Path("unused.pdf"))
