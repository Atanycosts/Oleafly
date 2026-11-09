"""Deterministic PDF source analysis bound to page geometry.

Captured PDF guidance yields reading-ordered text blocks with exact page numbers
and point-unit bounding boxes so every fragment can be located back to the PDF
without a rendered image. Extraction follows the PDF text layer only: pages
without a text layer stay an explicit per-page coverage gap, and only blocks
matching the narrow explicit requirement grammar can confirm rules in the world
analyzer. The page preview renders in the same unrotated coordinate frame the
bounding boxes use.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import cast

import pymupdf

from research_file_workbench.journals.models import WorldAnalysisError

PDF_SOURCE_VERSION = "journal-pdf-source-1.0.0"

_Box = tuple[float, float, float, float]

_COLUMN_TOLERANCE_POINTS = 6.0
_SPANNING_FRACTION = 0.1
_MIN_HEADING_CHARACTERS = 2
_MAX_HEADING_CHARACTERS = 60
# Span flags are a bitmask: bold is bit 4, whose value is 16 (serifed is 4, italic 2).
_BOLD_FLAG = 16

_BAND_SPANNING = 0
_BAND_LEFT = 1
_BAND_RIGHT = 2


@dataclass(frozen=True)
class PdfTextBlock:
    """One text-layer block in declared reading order with its exact location."""

    page_number: int
    block_number: int
    column_band: int
    kind: str
    text: str
    bbox: _Box
    font_size: float
    bold: bool


@dataclass(frozen=True)
class _RawSpan:
    text: str
    size: float
    bold: bool


@dataclass(frozen=True)
class _RawLine:
    bbox: _Box
    spans: tuple[_RawSpan, ...]


@dataclass(frozen=True)
class _RawBlock:
    bbox: _Box
    lines: tuple[_RawLine, ...]


@dataclass(frozen=True)
class _RawPage:
    width: float
    blocks: tuple[_RawBlock, ...]


def _open_pdf(payload: bytes, source_label: str) -> pymupdf.Document:
    """Open captured PDF bytes, refusing unreadable or encrypted documents."""
    try:
        # pymupdf ships partial stubs; the entry points used here are untyped.
        document = pymupdf.open(stream=payload, filetype="pdf")  # type: ignore[no-untyped-call]
    except (RuntimeError, ValueError, pymupdf.mupdf.FzErrorBase) as exc:
        raise WorldAnalysisError(
            f"PDF source {source_label} is not a readable PDF document"
        ) from exc
    if document.needs_pass:
        document.close()  # type: ignore[no-untyped-call]
        raise WorldAnalysisError(
            f"PDF source {source_label} is encrypted; locked guidance is unsupported"
        )
    if document.page_count == 0:
        document.close()  # type: ignore[no-untyped-call]
        raise WorldAnalysisError(f"PDF source {source_label} has no pages")
    return document


def analyze_pdf_bytes(payload: bytes, source_label: str) -> tuple[list[PdfTextBlock], list[str]]:
    """Analyze captured PDF bytes into reading-ordered blocks and explicit issues.

    A structurally invalid or encrypted document fails the operation; a readable
    document without any text layer returns no blocks and one explicit issue
    instead of fabricated content.
    """
    document = _open_pdf(payload, source_label)
    try:
        try:
            pages = [
                _page_text(document.load_page(index))  # type: ignore[no-untyped-call]
                for index in range(document.page_count)
            ]
        except pymupdf.mupdf.FzErrorBase as exc:
            # MuPDF failures (FzError*) do not derive from ValueError; convert them so the
            # HTTP boundary always answers with a typed JSON error, never a dropped connection.
            raise WorldAnalysisError(f"PDF source {source_label} could not be analyzed") from exc
    finally:
        document.close()  # type: ignore[no-untyped-call]
    body_size = _body_size(pages)
    if body_size is None:
        return [], [
            "PDF source contains no extractable text layer; scanned guidance requires "
            "OCR, which is not implemented."
        ]
    issues: list[str] = []
    textless_pages = [number for number, page in enumerate(pages, start=1) if not page.blocks]
    for number in textless_pages:
        issues.append(f"PDF page {number} has no extractable text layer.")
    blocks: list[PdfTextBlock] = []
    for page_number, page in enumerate(pages, start=1):
        prepared: list[tuple[_RawBlock, str, int]] = []
        for index, raw in enumerate(page.blocks):
            text = _block_text(raw)
            if text.strip():
                prepared.append((raw, text, index))
        ordered = sorted(
            prepared,
            key=lambda item: (
                _column_band(item[0], page.width),
                item[0].bbox[1],
                item[0].bbox[0],
                item[2],
            ),
        )
        for block_number, (raw, text, _) in enumerate(ordered, start=1):
            blocks.append(
                PdfTextBlock(
                    page_number=page_number,
                    block_number=block_number,
                    column_band=_column_band(raw, page.width),
                    kind=_block_kind(raw, body_size, text),
                    text=text,
                    bbox=raw.bbox,
                    font_size=_dominant_size(raw),
                    bold=_block_bold(raw),
                )
            )
    return blocks, issues


def _page_text(page: pymupdf.Page) -> _RawPage:
    payload = page.get_text("dict")  # type: ignore[no-untyped-call]
    blocks: list[_RawBlock] = []
    for raw in payload["blocks"]:
        if raw["type"] != 0:
            continue
        lines: list[_RawLine] = []
        for line in raw["lines"]:
            spans = tuple(
                _RawSpan(
                    text=span["text"],
                    size=span["size"],
                    bold=bool(span["flags"] & _BOLD_FLAG),
                )
                for span in line["spans"]
            )
            if spans:
                lines.append(
                    _RawLine(
                        bbox=cast(_Box, tuple(line["bbox"])),
                        spans=spans,
                    )
                )
        if lines:
            blocks.append(_RawBlock(bbox=cast(_Box, tuple(raw["bbox"])), lines=tuple(lines)))
    # Text bboxes live in the unrotated page space, so banding and the page preview must
    # both use the unrotated cropbox width, never the rotation-applied page.rect.
    return _RawPage(width=cast(float, page.cropbox.width), blocks=tuple(blocks))


def _body_size(pages: list[_RawPage]) -> float | None:
    sizes = sorted(
        span.size
        for page in pages
        for block in page.blocks
        for line in block.lines
        for span in line.spans
    )
    if not sizes:
        return None
    middle = len(sizes) // 2
    if len(sizes) % 2:
        return sizes[middle]
    return (sizes[middle - 1] + sizes[middle]) / 2


def _column_band(block: _RawBlock, width: float) -> int:
    mid = width / 2
    margin = width * _SPANNING_FRACTION
    x0, _, x1, _ = block.bbox
    if x0 < mid - margin and x1 > mid + margin:
        return _BAND_SPANNING
    if x1 <= mid + _COLUMN_TOLERANCE_POINTS:
        return _BAND_LEFT
    if x0 >= mid - _COLUMN_TOLERANCE_POINTS:
        return _BAND_RIGHT
    return _BAND_LEFT if (x0 + x1) / 2 < mid else _BAND_RIGHT


def _block_text(block: _RawBlock) -> str:
    return "\n".join("".join(span.text for span in line.spans) for line in block.lines)


def _dominant_size(block: _RawBlock) -> float:
    return max(span.size for line in block.lines for span in line.spans)


def _block_bold(block: _RawBlock) -> bool:
    return any(span.bold for line in block.lines for span in line.spans)


def _block_kind(block: _RawBlock, body_size: float, text: str) -> str:
    stripped = text.strip()
    dominant = _dominant_size(block)
    if dominant > body_size:
        # Any block whose largest glyph exceeds the body median is structurally
        # emphasized; single-character drop caps stay paragraphs.
        return "heading" if len(stripped) >= _MIN_HEADING_CHARACTERS else "paragraph"
    if (
        _block_bold(block)
        and dominant >= body_size
        and len(block.lines) == 1
        and _MIN_HEADING_CHARACTERS <= len(stripped) <= _MAX_HEADING_CHARACTERS
    ):
        return "heading"
    return "paragraph"


_PREVIEW_DPI = 110
_MAX_PREVIEW_PIXELS = 12_000_000


def render_pdf_page(payload: bytes, page_number: int, source_label: str) -> dict[str, object]:
    """Render one retained PDF page to base64 PNG pixels for the local review preview.

    Rotated pages render in their unrotated page space so the image shares the exact
    coordinate frame of the fragment bounding boxes; text bboxes never live in the
    rotation-applied space. The preview is a request-time derived image of captured
    bytes. It is not a retained render artifact, carries no evidence authority, and
    never touches a host path.
    """
    document = _open_pdf(payload, source_label)
    try:
        if not 1 <= page_number <= document.page_count:
            raise ValueError(
                f"PDF source {source_label} has no page {page_number}; "
                f"pages run 1..{document.page_count}"
            )
        try:
            page = document.load_page(page_number - 1)  # type: ignore[no-untyped-call]
            zoom = _PREVIEW_DPI / 72
            width_pt = cast(float, page.cropbox.width)
            height_pt = cast(float, page.cropbox.height)
            if width_pt * zoom * height_pt * zoom > _MAX_PREVIEW_PIXELS:
                raise ValueError(
                    f"PDF source {source_label} page {page_number} is too large to preview"
                )
            # Render in the same unrotated frame the text bboxes use.
            matrix = pymupdf.Matrix(zoom, zoom) * page.derotation_matrix  # type: ignore[no-untyped-call]
            pixmap = page.get_pixmap(matrix=matrix)
            png = pixmap.tobytes(output="png")
        except pymupdf.mupdf.FzErrorBase as exc:
            raise WorldAnalysisError(
                f"PDF source {source_label} page {page_number} could not be rendered"
            ) from exc
        return {
            "page": page_number,
            "page_count": document.page_count,
            "width_pt": width_pt,
            "height_pt": height_pt,
            "dpi": _PREVIEW_DPI,
            "png_base64": base64.b64encode(png).decode("ascii"),
        }
    finally:
        document.close()  # type: ignore[no-untyped-call]
