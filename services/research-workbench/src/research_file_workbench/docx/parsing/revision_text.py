"""Read-only accepted text over selected Word content, without changing source locators."""

from __future__ import annotations

from collections.abc import Iterator
from xml.etree.ElementTree import Element

from research_file_workbench.docx.models import DocxTextProjection
from research_file_workbench.docx.parsing.markup_compatibility import (
    MARKUP_COMPATIBILITY_NAMESPACE,
    missing_branch_paths,
)
from research_file_workbench.docx.xml_support import (
    WORD_NAMESPACE,
    iter_selected,
    selected_children,
    text_token,
)

_WORD = f"{{{WORD_NAMESPACE}}}"
_PARAGRAPH = f"{_WORD}p"
_TEXTBOX = f"{_WORD}txbxContent"
_ALT = f"{{{MARKUP_COMPATIBILITY_NAMESPACE}}}AlternateContent"
_REMOVED = {f"{_WORD}{name}" for name in ("del", "delText", "moveFrom")}
_TRACKED = _REMOVED | {f"{_WORD}{name}" for name in ("ins", "moveTo")}
_MOVE_BOUNDARIES = {
    f"{_WORD}{move}Range{side}": (f"{_WORD}{move}", side)
    for move in ("moveFrom", "moveTo")
    for side in ("Start", "End")
}
_TABLE_MARKS = {f"{_WORD}{name}" for name in ("cellIns", "cellDel", "cellMerge", "tblGridChange")}
_TABLE_STRUCTURE = {f"{_WORD}{name}" for name in ("tbl", "tr", "trPr", "tcPr", "tblGrid")}
_TEXT_OWNERS = {_PARAGRAPH, f"{_WORD}tc", f"{_WORD}comment", f"{_WORD}tbl"}
_STORIES = {
    f"{_WORD}{name}" for name in ("body", "hdr", "ftr", "footnote", "endnote", "tc", "comment")
} | {_TEXTBOX}
_PROJECTION_TAGS = _TRACKED | _MOVE_BOUNDARIES.keys() | _TABLE_MARKS | {_ALT}


class RevisionText:
    """Index revision context once for the source part or comment being projected."""

    def __init__(self, root: Element) -> None:
        self._parents: dict[Element, Element] = {}
        self._unavailable: dict[Element, str] = {}
        if not any(element.tag in _PROJECTION_TAGS for element in root.iter()):
            return

        ordered = list(iter_selected(root))
        self._parents = {child: parent for parent in ordered for child in selected_children(parent)}
        paragraph_marks: set[Element] = set()
        for element, parent in self._parents.items():
            tag = element.tag
            if (tag in _TRACKED and parent.tag in _TABLE_STRUCTURE) or tag in _TABLE_MARKS:
                for ancestor in self._ancestry(parent):
                    if ancestor.tag == f"{_WORD}tbl":
                        self._unavailable[ancestor] = "table_structure_revision"
                        break
            elif tag in _TRACKED and parent.tag == f"{_WORD}rPr":
                properties = self._parents.get(parent)
                if properties is not None and properties.tag == f"{_WORD}pPr":
                    paragraph = self._parents.get(properties)
                    if paragraph is not None and paragraph.tag == _PARAGRAPH:
                        paragraph_marks.add(paragraph)

        if paragraph_marks:
            pending: set[Element] = set()
            for element in ordered:
                if element.tag != _PARAGRAPH:
                    continue
                ancestry = tuple(self._ancestry(element))
                if any(node.tag in _REMOVED for node in ancestry):
                    continue
                story = next((node for node in ancestry if node.tag in _STORIES), root)
                if story in pending:
                    self._unavailable[element] = "paragraph_boundary_revision"
                    pending.remove(story)
                if element in paragraph_marks:
                    self._unavailable[element] = "paragraph_boundary_revision"
                    pending.add(story)

        for path in missing_branch_paths(root):
            chain = [root]
            for index in path[1:]:
                chain.append(chain[-1][index])
            if any(element.tag in _REMOVED for element in chain):
                continue
            for owner in reversed(chain):
                if owner.tag in _TEXT_OWNERS:
                    self._unavailable[owner] = "alternate_content_gap"
                    break
        if any(element.tag in _MOVE_BOUNDARIES for element in ordered):
            self._locate_move_range_gaps(root, ordered)

    def project(
        self, element: Element, source_text: str, *, paragraph_only: bool = False
    ) -> DocxTextProjection | None:
        """Return changed accepted text, an explicit gap, or no delta from source text."""
        if not self._parents and not self._unavailable:
            return None
        for ancestor in self._ancestry(element):
            if (reason := self._unavailable.get(ancestor)) is not None:
                return DocxTextProjection(None, reason)
            if ancestor.tag in _REMOVED:
                return DocxTextProjection("") if source_text else None

        parts: list[str] = []
        paragraph_seen = False
        for descendant in _accepted_elements(element, paragraph_only=paragraph_only):
            if (reason := self._unavailable.get(descendant)) is not None:
                return DocxTextProjection(None, reason)
            if not paragraph_only and descendant.tag == _PARAGRAPH:
                if paragraph_seen:
                    parts.append("\n")
                paragraph_seen = True
            parts.append(text_token(descendant))
        accepted = "".join(parts)
        return DocxTextProjection(accepted) if accepted != source_text else None

    def _ancestry(self, element: Element) -> Iterator[Element]:
        current: Element | None = element
        while current is not None:
            yield current
            current = self._parents.get(current)

    def _locate_move_range_gaps(self, root: Element, ordered: list[Element]) -> None:
        """Read move wrappers; range markers alone do not identify movable text reliably."""
        active: set[tuple[str, str]] = set()
        for element in ordered:
            boundary = _MOVE_BOUNDARIES.get(element.tag)
            if boundary is not None:
                wrapper, side = boundary
                identity = element.get(f"{_WORD}id")
                if identity is None:
                    self._unavailable[root] = "move_range_revision"
                    return
                key = (wrapper, identity)
                if (key in active) == (side == "Start"):
                    self._unavailable[root] = "move_range_revision"
                    return
                if side == "Start":
                    active.add(key)
                else:
                    active.remove(key)
            elif active and text_token(element):
                ancestry = tuple(self._ancestry(element))
                tags = {node.tag for node in ancestry}
                if any(wrapper not in tags for wrapper, _ in active):
                    owner = next((node for node in ancestry if node.tag in _TEXT_OWNERS), root)
                    self._unavailable[owner] = "move_range_revision"
        if active:
            self._unavailable[root] = "move_range_revision"


def _accepted_elements(element: Element, *, paragraph_only: bool) -> Iterator[Element]:
    if element.tag in _REMOVED:
        return
    yield element
    for child in selected_children(element):
        if not paragraph_only or child.tag not in {_PARAGRAPH, _TEXTBOX}:
            yield from _accepted_elements(child, paragraph_only=paragraph_only)
