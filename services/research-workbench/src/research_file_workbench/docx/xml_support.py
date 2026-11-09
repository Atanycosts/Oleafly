"""Namespace-aware traversal and text projection shared by DOCX parsers."""

from __future__ import annotations

from collections.abc import Iterator
from xml.etree import ElementTree

WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MATH_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/math"
OFFICE_RELATIONSHIP_NAMESPACE = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
)
MARKUP_COMPATIBILITY_NAMESPACE = "http://schemas.openxmlformats.org/markup-compatibility/2006"
WORDPROCESSING_DRAWING_NAMESPACE = (
    "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
)
DRAWING_MAIN_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main"


def paragraphs(
    root: ElementTree.Element, in_textbox: bool = False
) -> list[tuple[ElementTree.Element, bool]]:
    """List selected Word paragraphs in source order, retaining textbox membership."""
    found: list[tuple[ElementTree.Element, bool]] = []
    for child in selected_children(root):
        child_in_textbox = in_textbox or child.tag == f"{{{WORD_NAMESPACE}}}txbxContent"
        if child.tag == f"{{{WORD_NAMESPACE}}}p":
            found.append((child, child_in_textbox))
        found.extend(paragraphs(child, child_in_textbox))
    return found


def paragraph_content(paragraph: ElementTree.Element) -> list[ElementTree.Element]:
    """Return selected descendants without entering another paragraph or textbox."""
    found = [paragraph]
    for child in selected_children(paragraph):
        if child.tag not in {f"{{{WORD_NAMESPACE}}}p", f"{{{WORD_NAMESPACE}}}txbxContent"}:
            found.extend(paragraph_content(child))
    return found


def paragraph_membership(root: ElementTree.Element, part_path: str) -> dict[int, str]:
    """Bind selected nodes to their nearest Word paragraph, including nested textboxes."""
    membership: dict[int, str] = {}
    for index, (paragraph, _) in enumerate(paragraphs(root), start=1):
        locator = f"{part_path}#paragraph[{index}]"
        for element in paragraph_content(paragraph):
            membership[id(element)] = locator
    return membership


def region_for_part(part_path: str) -> str | None:
    """Identify a supported Word content region from its package part name."""
    lower_path = part_path.casefold()
    if lower_path == "word/document.xml":
        return "body"
    if lower_path.startswith("word/header") and lower_path.endswith(".xml"):
        return "header"
    if lower_path.startswith("word/footer") and lower_path.endswith(".xml"):
        return "footer"
    if lower_path == "word/footnotes.xml":
        return "footnote"
    if lower_path == "word/endnotes.xml":
        return "endnote"
    return None


def is_text_element(element: ElementTree.Element) -> bool:
    """Return whether an element carries Word or OMML source text."""
    if not isinstance(element.tag, str):
        return False
    namespace = element.tag.partition("}")[0].lstrip("{")
    return namespace in {WORD_NAMESPACE, MATH_NAMESPACE} and tag_local_name(element.tag) in {
        "t",
        "delText",
    }


def tag_local_name(tag: str) -> str:
    """Return the local name of an expanded XML tag."""
    return tag.rsplit("}", 1)[-1]


def iter_selected(root: ElementTree.Element) -> Iterator[ElementTree.Element]:
    """Walk the selected branch of each markup-compatibility container."""
    yield root
    for child in selected_children(root):
        yield from iter_selected(child)


def selected_children(element: ElementTree.Element) -> tuple[ElementTree.Element, ...]:
    """Select the explicit fallback branch when alternative content provides one."""
    if tag_local_name(element.tag) != "AlternateContent":
        return tuple(element)
    # Unknown Choice requirements cannot be treated as rendered truth; use the explicit fallback
    # for text/layout projection while complex-object registration inspects all package branches.
    fallback = next(
        (
            child
            for child in element
            if child.tag == f"{{{MARKUP_COMPATIBILITY_NAMESPACE}}}Fallback"
        ),
        None,
    )
    choice = next(
        (child for child in element if child.tag == f"{{{MARKUP_COMPATIBILITY_NAMESPACE}}}Choice"),
        None,
    )
    selected = fallback if fallback is not None else choice
    return tuple(selected) if selected is not None else ()


def first_child(element: ElementTree.Element | None, local_name: str) -> ElementTree.Element | None:
    """Return the first direct child with the requested local tag name."""
    if element is None:
        return None
    return next((child for child in element if tag_local_name(child.tag) == local_name), None)


def first_descendant(
    element: ElementTree.Element, namespace: str, local_name: str
) -> ElementTree.Element | None:
    """Return the first descendant with the requested expanded tag name."""
    qualified_name = f"{{{namespace}}}{local_name}"
    return next((child for child in element.iter(qualified_name)), None)


def string_attribute(
    element: ElementTree.Element | None, namespace: str, local_name: str
) -> str | None:
    """Read a qualified attribute or its schema-defined unqualified spelling."""
    if element is None:
        return None
    return element.get(f"{{{namespace}}}{local_name}") or element.get(local_name)


def integer_attribute(
    element: ElementTree.Element | None, namespace: str, local_name: str
) -> int | None:
    """Read an optional integer attribute; absent or invalid values stay unknown."""
    value = string_attribute(element, namespace, local_name)
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        return None


def text_from_element(element: ElementTree.Element) -> str:
    """Project selected content while preserving paragraph and inline separators."""
    text_parts: list[str] = []
    paragraph_seen = False
    for child in iter_selected(element):
        if child.tag == f"{{{WORD_NAMESPACE}}}p":
            if paragraph_seen:
                text_parts.append("\n")
            paragraph_seen = True
        text_parts.append(text_token(child))
    return "".join(text_parts)


def text_token(element: ElementTree.Element) -> str:
    """Project one text-bearing element or explicit Word separator."""
    if is_text_element(element):
        return element.text or ""
    return {
        f"{{{WORD_NAMESPACE}}}tab": "\t",
        f"{{{WORD_NAMESPACE}}}br": "\n",
        f"{{{WORD_NAMESPACE}}}cr": "\n",
        f"{{{WORD_NAMESPACE}}}noBreakHyphen": "\u2011",
        f"{{{WORD_NAMESPACE}}}softHyphen": "\u00ad",
    }.get(element.tag, "")


def on_off_value(element: ElementTree.Element | None) -> bool:
    """Read an explicit Word on/off property, including false-valued elements."""
    return element is not None and string_attribute(element, WORD_NAMESPACE, "val") not in {
        "0",
        "false",
        "off",
    }
