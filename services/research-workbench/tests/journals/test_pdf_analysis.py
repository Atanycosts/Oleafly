"""PDF source analysis: deterministic blocks, heading rules and explicit gaps.

Synthetic layouts respect the extractor's declared block semantics: consecutive
lines with regular leading merge into one block, and same-baseline text that is
adjacent in the content stream merges regardless of the horizontal gap.
"""

import base64
from io import BytesIO
from typing import cast

import pymupdf
import pytest
from PIL import Image

from research_file_workbench.journals.models import WorldAnalysisError
from research_file_workbench.journals.pdf_analysis import (
    PDF_SOURCE_VERSION,
    analyze_pdf_bytes,
    render_pdf_page,
)

# (x, y, text, size, font) tuples for one page of text.
PageLines = list[tuple[float, float, str, float, str]]

TWO_BODY_LINES: PageLines = [
    (50, 100, "Body line one", 10.0, "helv"),
    (50, 112, "Body line two", 10.0, "helv"),
]


def build_pdf(pages: list[PageLines]) -> bytes:
    document = pymupdf.open()
    for lines in pages:
        page = document.new_page(width=595, height=842)
        for x, y, text, size, font in lines:
            page.insert_text((x, y), text, fontsize=size, fontname=font)
    payload = document.tobytes()
    document.close()
    return payload


def block_texts(blocks: list) -> list[str]:
    return [block.text for block in blocks]


def test_blocks_carry_page_bbox_and_dense_reading_order() -> None:
    blocks, issues = analyze_pdf_bytes(
        build_pdf(
            [[(50, 100, "First paragraph", 10.0, "helv"), (50, 200, "Second", 10.0, "helv")]]
        ),
        "guide.pdf",
    )
    assert issues == []
    assert [block.block_number for block in blocks] == [1, 2]
    assert all(block.page_number == 1 for block in blocks)
    first, second = blocks
    assert first.text == "First paragraph"
    assert first.kind == "paragraph"
    assert first.column_band == 1
    assert first.bbox[0] == pytest.approx(50.0, abs=0.5)
    assert first.bbox[1] < second.bbox[1]
    assert all(0 <= value <= 595 for value in first.bbox[::2])


def test_regular_leading_merges_into_one_block_text() -> None:
    blocks, _ = analyze_pdf_bytes(build_pdf([TWO_BODY_LINES]), "guide.pdf")
    assert block_texts(blocks) == ["Body line one\nBody line two"]


def test_larger_text_is_heading_and_dropcap_stays_paragraph() -> None:
    lines = [
        *TWO_BODY_LINES,
        (50, 160, "Big Title Here", 20.0, "helv"),
        (50, 260, "B", 18.0, "helv"),
    ]
    blocks, _ = analyze_pdf_bytes(build_pdf([lines]), "guide.pdf")
    kinds = {block.text: block.kind for block in blocks}
    assert kinds["Big Title Here"] == "heading"
    assert kinds["B"] == "paragraph"
    assert kinds["Body line one\nBody line two"] == "paragraph"


def test_same_size_bold_single_line_is_heading() -> None:
    lines = [
        (50, 100, "Bold Heading", 10.0, "hebo"),
        (320, 112, "regular body text", 10.0, "helv"),
    ]
    blocks, _ = analyze_pdf_bytes(build_pdf([lines]), "guide.pdf")
    kinds = {block.text: block.kind for block in blocks}
    assert kinds["Bold Heading"] == "heading"
    assert kinds["regular body text"] == "paragraph"


def test_sub_body_bold_table_header_stays_paragraph() -> None:
    lines = [
        (50, 100, "Burst throughput", 7.5, "hebo"),
        (50, 160, "regular body text", 10.0, "helv"),
    ]
    blocks, _ = analyze_pdf_bytes(build_pdf([lines]), "guide.pdf")
    kinds = {block.text: block.kind for block in blocks}
    assert kinds["Burst throughput"] == "paragraph"


def test_two_column_reading_order_puts_left_band_before_right_band() -> None:
    lines = [
        (320, 200, "Right line one", 10.0, "helv"),
        (50, 100, "Left line one", 10.0, "helv"),
        (320, 212, "Right line two", 10.0, "helv"),
        (50, 112, "Left line two", 10.0, "helv"),
    ]
    blocks, _ = analyze_pdf_bytes(build_pdf([lines]), "guide.pdf")
    assert [(block.column_band, block.text) for block in blocks] == [
        (1, "Left line one"),
        (1, "Left line two"),
        (2, "Right line one"),
        (2, "Right line two"),
    ]


def test_spanning_block_is_ordered_before_column_bands() -> None:
    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((50, 120), "Left body", fontsize=10.0)
    page.insert_text((320, 240), "Right body", fontsize=10.0)
    page.insert_text((60, 60), "A Widely Spanning Page Title Across The Sheet", fontsize=20.0)
    payload = document.tobytes()
    document.close()
    blocks, _ = analyze_pdf_bytes(payload, "guide.pdf")
    assert [(block.column_band, block.text) for block in blocks] == [
        (0, "A Widely Spanning Page Title Across The Sheet"),
        (1, "Left body"),
        (2, "Right body"),
    ]


def test_analysis_is_deterministic_for_identical_bytes() -> None:
    payload = build_pdf([TWO_BODY_LINES])
    assert analyze_pdf_bytes(payload, "guide.pdf") == analyze_pdf_bytes(payload, "guide.pdf")


def test_multi_page_blocks_keep_one_based_page_numbers() -> None:
    payload = build_pdf(
        [
            [(50, 100, "First page body", 10.0, "helv")],
            [(50, 100, "Second page body", 10.0, "helv")],
        ]
    )
    blocks, _ = analyze_pdf_bytes(payload, "guide.pdf")
    assert [block.page_number for block in blocks] == [1, 2]
    assert block_texts(blocks) == ["First page body", "Second page body"]


def test_invalid_bytes_fail_without_fabricating_blocks() -> None:
    with pytest.raises(WorldAnalysisError, match="not a readable PDF"):
        analyze_pdf_bytes(b"%PDF-captured", "guide.pdf")
    with pytest.raises(WorldAnalysisError, match="not a readable PDF"):
        analyze_pdf_bytes(b"", "guide.pdf")


def test_encrypted_pdf_is_refused() -> None:
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((50, 100), "Secret", fontsize=10.0)
    payload = document.tobytes(
        encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="user"
    )
    document.close()
    with pytest.raises(WorldAnalysisError, match="encrypted"):
        analyze_pdf_bytes(payload, "guide.pdf")


def test_page_without_text_layer_is_an_explicit_gap() -> None:
    document = pymupdf.open()
    document.new_page()
    payload = document.tobytes()
    document.close()
    blocks, issues = analyze_pdf_bytes(payload, "scan.pdf")
    assert blocks == []
    assert len(issues) == 1
    assert "no extractable text layer" in issues[0]


def test_mixed_text_and_scanned_pages_stay_extracted_with_gaps() -> None:
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((50, 100), "Readable body", fontsize=10.0)
    document.new_page()  # An image-only page: no text layer at all.
    payload = document.tobytes()
    document.close()
    blocks, issues = analyze_pdf_bytes(payload, "mixed.pdf")
    assert block_texts(blocks) == ["Readable body"]
    assert issues == ["PDF page 2 has no extractable text layer."]


def test_pdf_source_version_is_declared() -> None:
    assert PDF_SOURCE_VERSION == "journal-pdf-source-1.0.0"


def test_rotated_page_preview_matches_the_text_bbox_frame() -> None:
    document = pymupdf.open()
    page = document.new_page(width=400, height=600)
    page.insert_text((100, 150), "Marker Text Here", fontsize=12.0)
    page.set_rotation(90)
    payload = document.tobytes()
    document.close()
    blocks, _ = analyze_pdf_bytes(payload, "rot.pdf")
    preview = render_pdf_page(payload, 1, "rot.pdf")
    # width/height describe the unrotated frame the bboxes live in, not page.rect.
    assert preview["width_pt"] == pytest.approx(400)
    assert preview["height_pt"] == pytest.approx(600)
    box = blocks[0].bbox
    assert box[0] >= 0 and box[2] <= cast(float, preview["width_pt"])
    assert box[1] >= 0 and box[3] <= cast(float, preview["height_pt"])
    image = Image.open(BytesIO(base64.b64decode(cast(str, preview["png_base64"]))))
    assert image.width == pytest.approx(400 * 110 / 72, abs=2)
    assert image.height == pytest.approx(600 * 110 / 72, abs=2)
    center = (
        int((box[0] + box[2]) / 2 * 110 / 72),
        int((box[1] + box[3]) / 2 * 110 / 72),
    )
    neighborhood = [
        image.getpixel((center[0] + dx, center[1] + dy))
        for dx in range(-4, 5)
        for dy in range(-4, 5)
        if 0 <= center[0] + dx < image.width and 0 <= center[1] + dy < image.height
    ]
    # A wrong preview frame would leave this neighborhood blank: the page carries a single
    # text object, so nearby ink proves the image shares the bbox coordinate frame.
    assert any(sum(pixel[:3]) < 720 for pixel in neighborhood)


def test_oversized_page_preview_is_refused_before_rendering() -> None:
    document = pymupdf.open()
    document.new_page(width=100_000, height=100_000)
    payload = document.tobytes()
    document.close()
    with pytest.raises(ValueError, match="too large to preview"):
        render_pdf_page(payload, 1, "huge.pdf")
