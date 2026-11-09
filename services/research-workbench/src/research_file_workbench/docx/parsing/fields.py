"""Field instructions, results, and boundary parsing within independent Word stories."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from xml.etree import ElementTree

from research_file_workbench.docx.models import DocxField
from research_file_workbench.docx.xml_support import (
    WORD_NAMESPACE,
    iter_selected,
    paragraph_membership,
    region_for_part,
    selected_children,
    string_attribute,
    text_token,
)

_STORY_TAGS = {
    f"{{{WORD_NAMESPACE}}}txbxContent",
    f"{{{WORD_NAMESPACE}}}footnote",
    f"{{{WORD_NAMESPACE}}}endnote",
}


def read_fields(
    xml_roots: dict[str, ElementTree.Element],
) -> tuple[tuple[DocxField, ...], list[str]]:
    """Read simple and complex fields, keeping cross-paragraph stacks within one story."""
    fields: list[DocxField] = []
    issues: list[str] = []
    for part_path, root in xml_roots.items():
        if region_for_part(part_path) is None:
            continue
        membership = paragraph_membership(root, part_path)
        occurrences: dict[str, int] = {}
        stories = [
            root,
            *(element for element in iter_selected(root) if element.tag in _STORY_TAGS),
        ]
        for story in stories:
            stack: list[_FieldFrame] = []
            for entering, element in _story_events(story):
                locator = membership.get(id(element))
                if locator is None:
                    continue
                if element.tag == f"{{{WORD_NAMESPACE}}}fldSimple":
                    if entering:
                        instruction = string_attribute(element, WORD_NAMESPACE, "instr")
                        if instruction is None:
                            issues.append(f"field-without-instruction:{locator}")
                        frame = _start_frame(stack, occurrences, locator, simple=True)
                        frame.instruction_parts.append(instruction or "")
                    elif stack and stack[-1].simple:
                        fields.append(_finish_field(part_path, stack.pop()))
                    else:
                        issues.append(f"field-simple-boundary-mismatch:{locator}")
                    continue
                if not entering:
                    continue
                if element.tag == f"{{{WORD_NAMESPACE}}}p":
                    for frame in stack:
                        if frame.separated:
                            frame.result_parts.append("\n")
                    continue
                if element.tag == f"{{{WORD_NAMESPACE}}}fldChar":
                    event = string_attribute(element, WORD_NAMESPACE, "fldCharType")
                    if event not in {"begin", "separate", "end"}:
                        issues.append(f"field-invalid-boundary:{locator}:{event}")
                        continue
                    for frame in stack:
                        frame.boundary_sequence.append(event)
                    if event == "begin":
                        _start_frame(stack, occurrences, locator, simple=False)
                    elif not stack or stack[-1].simple:
                        issues.append(f"field-{event}-without-begin:{locator}")
                    elif event == "separate":
                        if stack[-1].separated:
                            issues.append(f"field-repeated-separator:{locator}")
                        stack[-1].separated = True
                    else:
                        fields.append(_finish_field(part_path, stack.pop()))
                    continue
                if element.tag == f"{{{WORD_NAMESPACE}}}instrText":
                    if stack:
                        stack[-1].instruction_parts.append(element.text or "")
                    continue
                token = text_token(element)
                if token and stack:
                    # A nested result contributes to its enclosing displayed result only when
                    # every enclosing field is already in its result branch.
                    for frame in reversed(stack):
                        if not frame.separated:
                            break
                        frame.result_parts.append(token)
            for frame in stack:
                issues.append(f"field-without-end:{frame.node_locator}")
    return tuple(fields), issues


@dataclass
class _FieldFrame:
    """Mutable state for one field, anchored to the paragraph where it starts."""

    node_locator: str
    depth: int
    occurrence_index: int
    simple: bool
    instruction_parts: list[str] = field(default_factory=list)
    result_parts: list[str] = field(default_factory=list)
    boundary_sequence: list[str] = field(default_factory=list)
    separated: bool = False


def _start_frame(
    stack: list[_FieldFrame], occurrences: dict[str, int], locator: str, *, simple: bool
) -> _FieldFrame:
    occurrence = occurrences.get(locator, 0) + 1
    occurrences[locator] = occurrence
    frame = _FieldFrame(locator, len(stack), occurrence, simple)
    frame.boundary_sequence.append("simple" if simple else "begin")
    frame.separated = simple
    stack.append(frame)
    return frame


def _finish_field(part_path: str, frame: _FieldFrame) -> DocxField:
    instruction = "".join(frame.instruction_parts).strip()
    first_word = instruction.split(maxsplit=1)[0] if instruction else "unknown"
    return DocxField(
        part_path=part_path,
        node_locator=frame.node_locator,
        field_kind=first_word.casefold(),
        instruction=instruction,
        boundary_sequence=tuple(frame.boundary_sequence),
        result_text="".join(frame.result_parts),
        nested_level=frame.depth,
        occurrence_index=frame.occurrence_index,
    )


def _story_events(root: ElementTree.Element) -> Iterator[tuple[bool, ElementTree.Element]]:
    yield True, root
    for child in selected_children(root):
        if child.tag not in _STORY_TAGS:
            yield from _story_events(child)
    yield False, root
