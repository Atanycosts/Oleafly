"""Byte-offset positions for XML elements inside one DOCX package part.

`xml.etree.ElementTree` builds a tree and discards where each element came from, so a source
object cannot be pointed back at the exact bytes that produced it. The read receipt already
declares `ReadRange.start` and `ReadRange.end` offsets within a locator; without positions the
reader can never fill them, and a byte-faithful edit cannot be planned or verified.

This module reads the same bytes with `xml.parsers.expat`, which reports `CurrentByteIndex`, and
exposes one span per element in document order.

The two parsers walk the same document, so their elements align one-to-one in pre-order:
`ElementTree.iter()` yields the root followed by every descendant, and expat fires
`StartElementHandler` in exactly that order. `align_with` performs the join and refuses when the
two disagree, because a silently shifted span would point an edit at the wrong bytes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, cast
from xml.parsers import expat

if TYPE_CHECKING:
    from xml.etree.ElementTree import Element


class PositionError(ValueError):
    """Raised when byte positions cannot be aligned with the parsed document."""


@dataclass(frozen=True, slots=True)
class ElementSpan:
    """Where one element and its first character data sit in the part's bytes.

    `start` is the offset of the start tag's opening angle bracket and `end` is the offset just
    past the end tag's closing bracket, so `data[start:end]` is the whole element. `text_start`
    and `text_end` bracket the character data, so `data[text_start:text_end]` is the element's
    own text without markup. Both text offsets are absent for an element with no character data.
    """

    index: int
    name: str
    start: int
    end: int
    text_start: int | None = None
    text_end: int | None = None

    def covers_text(self) -> bool:
        """Return whether this element carries character data that can be addressed."""
        return self.text_start is not None and self.text_end is not None


def local_name(qualified: str) -> str:
    """Return the local part of a prefixed or Clark-notation name."""
    return qualified.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def _scan_tag(data: bytes, offset: int) -> tuple[int, bool]:
    """Return where the tag at `offset` ends, and whether it closes itself.

    A `>` inside a quoted attribute value does not close the tag, so the scan tracks quoting. A
    tag ending `/>` closes itself and has no end tag of its own, so the returned offset bounds
    the whole element; otherwise it bounds only the start tag and is replaced when the end tag
    arrives.
    """
    quote = 0
    for position in range(offset, len(data)):
        byte = data[position]
        if quote:
            if byte == quote:
                quote = 0
        elif byte in (0x22, 0x27):
            quote = byte
        elif byte == 0x3E:
            return position + 1, data[position - 1 : position] == b"/"
    raise PositionError(f"Unterminated tag at byte {offset}")


def element_spans(data: bytes) -> tuple[ElementSpan, ...]:
    """Return one span per element, in the order the two parsers both visit them.

    An expat handler reports the offset where the *current* event begins, so neither the end of
    an end tag nor the end of a run of character data is known at the moment its own handler
    fires. Both are therefore closed by the next event: the end tag is found by scanning to its
    closing bracket, and character data ends where the following markup begins. Deriving the text
    length from the decoded string instead would drift wherever the source uses an entity
    reference, because the raw bytes are longer than the characters they encode.
    """
    if not data:
        raise PositionError("Cannot locate positions in an empty part")

    parser = expat.ParserCreate()
    names: list[str] = []
    bounds: list[list[int | None]] = []
    closes_itself: list[bool] = []
    open_elements: list[int] = []
    open_text: list[int | None] = [None]

    def close_text(at: int) -> None:
        index = open_text[0]
        if index is not None:
            # Only the first run of character data is this element's own text; anything after a
            # child element belongs to that child's tail. Overwriting here would stretch the
            # span across the child's markup.
            if bounds[index][3] is None:
                bounds[index][3] = at
            open_text[0] = None

    def handle_start(name: str, _attributes: dict[str, str]) -> None:
        offset = parser.CurrentByteIndex
        close_text(offset)
        end, self_closing = _scan_tag(data, offset)
        names.append(name)
        bounds.append([offset, end, None, None])
        closes_itself.append(self_closing)
        open_elements.append(len(names) - 1)

    def handle_end(_name: str) -> None:
        offset = parser.CurrentByteIndex
        close_text(offset)
        index = open_elements.pop()
        # A self-closing tag raises an end event whose byte index sits at the *following* markup
        # rather than at the tag, so rescanning from there would swallow the next sibling. Its
        # span was already completed from the start tag.
        if not closes_itself[index]:
            bounds[index][1] = _scan_tag(data, offset)[0]

    def handle_text(_content: str) -> None:
        if not open_elements:
            return
        index = open_elements[-1]
        if bounds[index][2] is None:
            bounds[index][2] = parser.CurrentByteIndex
        open_text[0] = index

    parser.StartElementHandler = handle_start
    parser.EndElementHandler = handle_end
    parser.CharacterDataHandler = handle_text
    try:
        parser.Parse(data, True)
    except expat.ExpatError as exc:
        raise PositionError(f"Part is not well-formed XML: {exc}") from exc

    return tuple(
        ElementSpan(
            index=index,
            name=local_name(names[index]),
            start=cast(int, bounds[index][0]),
            end=cast(int, bounds[index][1]),
            text_start=bounds[index][2],
            text_end=bounds[index][3],
        )
        for index in range(len(names))
    )


def align_with(root: Element, spans: tuple[ElementSpan, ...]) -> dict[int, ElementSpan]:
    """Join spans to elements by pre-order position, refusing any disagreement.

    The join is by position rather than by name: a name-only match would silently accept a span
    from a different element that happens to share a tag, which is exactly the misalignment this
    function exists to prevent. Callers key the result by `id(element)`.
    """
    elements = list(root.iter())
    if len(elements) != len(spans):
        raise PositionError(
            f"Element count differs between parsers: tree={len(elements)} positions={len(spans)}"
        )
    aligned: dict[int, ElementSpan] = {}
    for element, span in zip(elements, spans, strict=True):
        tree_name = local_name(element.tag if isinstance(element.tag, str) else "")
        if tree_name != span.name:
            raise PositionError(
                f"Element order differs at position {span.index}: tree={tree_name} span={span.name}"
            )
        aligned[id(element)] = span
    return aligned
