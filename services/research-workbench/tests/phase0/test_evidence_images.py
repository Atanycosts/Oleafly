from pathlib import Path

import pytest

from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.png import PngInspectionError
from research_file_workbench.phase0 import evidence_checks


def test_page_hash_and_signature_cannot_validate_a_truncated_png(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pdf = tmp_path / "render.pdf"
    pdf.write_bytes(b"PDF inspected by a controlled test boundary")
    pages = tmp_path / "pages"
    pages.mkdir()
    image = pages / "page-1.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\n")
    monkeypatch.setattr(evidence_checks, "read_pdf_page_count", lambda path: 1)
    record = {
        "pdf_path": str(pdf),
        "pdf_sha256": sha256_file(pdf),
        "page_directory": str(pages),
        "page_count": 1,
        "pages": [{"page_number": 1, "path": str(image), "sha256": sha256_file(image)}],
    }

    with pytest.raises(PngInspectionError):
        evidence_checks.validate_pdf_pages(record)
