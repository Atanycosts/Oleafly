"""Read physical PDF metadata with the project's existing Poppler inspector."""

import re
import subprocess
from pathlib import Path


class PdfInspectionError(ValueError):
    """Raised when physical PDF metadata cannot be verified."""


def read_pdf_page_count(path: Path) -> int:
    """Return the physical page count, or raise when inspection fails."""
    try:
        result = subprocess.run(["pdfinfo", str(path)], capture_output=True, check=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as exc:
        raise PdfInspectionError(f"Cannot verify PDF page count: {path}: {exc}") from exc
    # Poppler emits a single Pages: field containing the physical page count.
    match = re.search(rb"^Pages:\s+(\d+)\s*$", result.stdout, re.MULTILINE)
    if match is None or int(match.group(1)) < 1:
        raise PdfInspectionError(f"PDF inspector did not report a positive page count: {path}")
    return int(match.group(1))
