"""A paragraph's byte range must identify the element that produced its text block.

The range is only useful if a later byte-level edit can trust it. That requires the exact
property this module tests: walking from the recorded offsets back to the source element and
projecting its text reproduces the block's text character for character. A range that merely
selects well-formed markup would still be useless if it named the wrong paragraph.
"""

from __future__ import annotations

import zipfile
from pathlib import Path
from xml.etree import ElementTree

import pytest

from research_file_workbench.docx.parsing.positions import align_with, element_spans
from research_file_workbench.docx.reader import read_docx
from research_file_workbench.docx.xml_support import (
    paragraph_content,
    region_for_part,
    text_token,
)

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "docx"
DOCUMENTS = sorted(FIXTURES.rglob("*.docx"))


def _text_from_paragraph(element: ElementTree.Element) -> str:
    """Reproduce the text projection content.py applies to one paragraph element."""
    return "".join(text_token(item) for item in paragraph_content(element))


@pytest.mark.parametrize("source", DOCUMENTS, ids=lambda path: path.stem)
def test_each_text_block_range_reaches_its_own_paragraph(source: Path) -> None:
    result = read_docx(source)
    located = [block for block in result.text_blocks if block.byte_start is not None]
    assert located, f"{source.stem}: no text block carries a byte range"

    with zipfile.ZipFile(source) as archive:
        payloads = {part: archive.read(part) for part in {block.part_path for block in located}}
    roots: dict[str, ElementTree.Element] = {
        part: ElementTree.fromstring(payload) for part, payload in payloads.items()
    }
    aligned = {
        part: align_with(root, element_spans(payloads[part])) for part, root in roots.items()
    }

    # Pair each block with the element its own bytes select, independently of how the reader
    # walked the tree: the span is looked up by offset, not by the reader's paragraph index.
    for block in located:
        spans = aligned[block.part_path]
        matches = [
            element
            for element in roots[block.part_path].iter()
            if element.tag.endswith("}p")
            and (span := spans.get(id(element))) is not None
            and span.start == block.byte_start
            and span.end == block.byte_end
        ]
        assert len(matches) == 1, (
            f"{source.stem}: {block.node_locator} range "
            f"{block.byte_start}..{block.byte_end} selects {len(matches)} paragraphs"
        )
        assert _text_from_paragraph(matches[0]) == block.text, (
            f"{source.stem}: {block.node_locator} range does not reach its own text"
        )


@pytest.mark.parametrize("source", DOCUMENTS, ids=lambda path: path.stem)
def test_a_range_is_inside_its_own_part(source: Path) -> None:
    """An offset is only meaningful against the part named beside it."""
    result = read_docx(source)
    with zipfile.ZipFile(source) as archive:
        sizes = {info.filename: info.file_size for info in archive.infolist()}
    for block in result.text_blocks:
        if block.byte_start is None or block.byte_end is None:
            continue
        assert 0 <= block.byte_start < block.byte_end <= sizes[block.part_path], (
            f"{source.stem}: {block.node_locator} range {block.byte_start}..{block.byte_end} "
            f"is outside {block.part_path} ({sizes[block.part_path]} bytes)"
        )


def test_only_supported_regions_carry_ranges() -> None:
    """A block without a region has no paragraph element to locate, so it carries no range."""
    for source in DOCUMENTS:
        result = read_docx(source)
        for block in result.text_blocks:
            assert region_for_part(block.part_path) is not None
            assert (block.byte_start is None) == (block.byte_end is None)
