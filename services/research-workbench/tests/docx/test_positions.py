"""Byte positions must point back at the exact bytes a parsed element came from."""

from __future__ import annotations

import zipfile
from pathlib import Path
from xml.etree import ElementTree

import pytest

from research_file_workbench.docx.parsing.positions import (
    PositionError,
    align_with,
    element_spans,
    local_name,
)

FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "docx"


def _fixture_parts() -> list[tuple[str, str]]:
    """Every XML part in every fixture, so the position layer is exercised generally.

    Covering only the Word content parts would miss the shapes that broke it: self-closing
    tags in customXml, and elements whose text is followed by children and then more text.
    """
    found = []
    for archive_path in sorted(FIXTURES.rglob("*.docx")):
        with zipfile.ZipFile(archive_path) as archive:
            for name in sorted(archive.namelist()):
                if name.endswith(".xml"):
                    found.append((archive_path.name, name))
    return found


PARTS_UNDER_TEST = _fixture_parts()


def test_local_name_handles_both_notations() -> None:
    assert local_name("{http://example}body") == "body"
    assert local_name("w:body") == "body"
    assert local_name("body") == "body"


def test_empty_input_is_refused() -> None:
    with pytest.raises(PositionError, match="empty part"):
        element_spans(b"")


def test_malformed_xml_is_refused() -> None:
    with pytest.raises(PositionError, match="well-formed"):
        element_spans(b"<w:document><w:body></w:document>")


def test_a_different_element_count_is_refused() -> None:
    """A count disagreement means the two parsers saw different documents; never guess."""
    root = ElementTree.fromstring(b"<a><b/></a>")
    spans = element_spans(b"<a><b/><c/></a>")
    with pytest.raises(PositionError, match="Element count differs"):
        align_with(root, spans)


def test_a_name_disagreement_is_refused() -> None:
    """Matching by position still verifies the name, so a shifted span cannot pass."""
    root = ElementTree.fromstring(b"<a><b/></a>")
    spans = element_spans(b"<a><c/></a>")
    with pytest.raises(PositionError, match="Element order differs"):
        align_with(root, spans)


def test_text_after_a_child_does_not_stretch_the_parent_span() -> None:
    """An element's own text is its first run; later text belongs to a child's tail."""
    data = b"<a>head<b>child</b>tail</a>"
    root = ElementTree.fromstring(data)
    aligned = align_with(root, element_spans(data))
    parent = aligned[id(root)]
    assert data[parent.text_start : parent.text_end] == b"head"
    child = aligned[id(root[0])]
    assert data[child.text_start : child.text_end] == b"child"


def test_a_self_closing_element_gets_a_complete_span() -> None:
    """expat raises an end event for a self-closing tag, but past it rather than at it."""
    data = b'<a x="1"><b y="2"/><c>text</c></a>'
    root = ElementTree.fromstring(data)
    aligned = align_with(root, element_spans(data))
    child = aligned[id(root[0])]
    assert data[child.start : child.end] == b'<b y="2"/>'
    assert not child.covers_text()


def test_a_quoted_angle_bracket_does_not_close_the_tag() -> None:
    """A '>' inside an attribute value is data, not the end of the tag."""
    data = b'<a title="x > y"><b/></a>'
    root = ElementTree.fromstring(data)
    aligned = align_with(root, element_spans(data))
    outer = aligned[id(root)]
    assert data[outer.start : outer.end] == data


@pytest.mark.parametrize(("archive_name", "part"), PARTS_UNDER_TEST)
def test_positions_round_trip_to_the_original_bytes(archive_name: str, part: str) -> None:
    """Every span must select the element, and every text span its exact character data.

    This is the property that makes a byte-faithful edit safe: if the offset were shifted by
    even one byte, the selected slice would not reproduce the text the tree reported.
    """
    archive_path = next(FIXTURES.rglob(archive_name))
    with zipfile.ZipFile(archive_path) as archive:
        data = archive.read(part)
    spans = element_spans(data)
    root = ElementTree.fromstring(data)
    aligned = align_with(root, spans)

    checked_text = 0
    for element in root.iter():
        span = aligned[id(element)]
        selected = data[span.start : span.end]
        assert selected.startswith(b"<"), f"{part}: span does not start at a tag: {selected[:20]!r}"
        assert selected.endswith(b">"), f"{part}: span does not end at a tag: {selected[-20:]!r}"
        if span.covers_text():
            actual = data[span.text_start : span.text_end].decode("utf-8")
            assert actual == (element.text or ""), f"{part}: text span disagrees for {span.name}"
            checked_text += 1

    if part == "word/document.xml":
        assert checked_text > 0, f"{part}: no character data was addressed at all"
