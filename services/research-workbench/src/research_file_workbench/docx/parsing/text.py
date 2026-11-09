"""Paragraph text observations and source byte-range alignment."""

from __future__ import annotations

from typing import Literal
from xml.etree import ElementTree

from research_file_workbench.docx.models import DocxStyle, DocxTextBlock
from research_file_workbench.docx.parsing.positions import (
    ElementSpan,
    PositionError,
    align_with,
    element_spans,
)
from research_file_workbench.docx.xml_support import (
    MATH_NAMESPACE,
    WORD_NAMESPACE,
    first_child,
    integer_attribute,
    on_off_value,
    paragraph_content,
    paragraphs,
    region_for_part,
    string_attribute,
    tag_local_name,
    text_token,
)


def read_text_blocks(
    xml_roots: dict[str, ElementTree.Element],
    styles: tuple[DocxStyle, ...] = (),
    *,
    xml_payloads: dict[str, bytes],
) -> tuple[tuple[DocxTextBlock, ...], list[str]]:
    """Read paragraph observations without joining adjacent words across separators.

    When the retained part bytes are supplied, each block also carries the byte range of its
    paragraph element so a later edit can address the exact source bytes. A part whose positions
    cannot be established is reported as an issue and its blocks keep an empty range, because a
    guessed offset would point an edit at the wrong bytes.
    """
    blocks: list[DocxTextBlock] = []
    issues: list[str] = []
    style_map = {style.style_id: style for style in styles}
    for part_path, root in xml_roots.items():
        region = region_for_part(part_path)
        if region is None:
            continue
        aligned: dict[int, ElementSpan] = {}
        payload = xml_payloads.get(part_path)
        if payload is not None:
            try:
                aligned = align_with(root, element_spans(payload))
            except PositionError as exc:
                issues.append(f"positions-unavailable:{part_path}:{exc}")
        for index, (paragraph, in_textbox) in enumerate(paragraphs(root), start=1):
            paragraph_elements = tuple(paragraph_content(paragraph))
            text = "".join(text_token(element) for element in paragraph_elements)
            if not text:
                continue
            local_names = {
                tag_local_name(element.tag)
                for element in paragraph_elements
                if isinstance(element.tag, str)
            }
            hidden = any(
                element.tag == f"{{{WORD_NAMESPACE}}}vanish" and on_off_value(element)
                for element in paragraph_elements
            )
            contains_field_code = bool(local_names & {"instrText", "fldChar", "fldSimple"})
            contains_omml = any(
                isinstance(element.tag, str)
                and element.tag.startswith(f"{{{MATH_NAMESPACE}}}")
                and tag_local_name(element.tag) in {"oMath", "oMathPara"}
                for element in paragraph_elements
            )
            revision_names = local_names & {"ins", "del"}
            revision_state: Literal["none", "inserted", "deleted", "mixed"]
            if revision_names == {"ins"}:
                revision_state = "inserted"
            elif revision_names == {"del"}:
                revision_state = "deleted"
            elif revision_names == {"ins", "del"}:
                revision_state = "mixed"
            else:
                revision_state = "none"
            block_region = "textbox" if in_textbox else region
            paragraph_style_id = _paragraph_style_id(paragraph)
            numbering_id, numbering_level = _paragraph_numbering(paragraph, style_map)
            span = aligned.get(id(paragraph))
            blocks.append(
                DocxTextBlock(
                    region=block_region,
                    part_path=part_path,
                    node_locator=f"{part_path}#paragraph[{index}]",
                    text=text,
                    parse_status="parsed",
                    hidden=hidden,
                    contains_field_code=contains_field_code,
                    contains_omml=contains_omml,
                    revision_state=revision_state,
                    paragraph_style_id=paragraph_style_id,
                    caption=paragraph_style_id == "Caption",
                    numbering_id=numbering_id,
                    numbering_level=numbering_level,
                    byte_start=span.start if span is not None else None,
                    byte_end=span.end if span is not None else None,
                )
            )
    if not blocks:
        issues.append("no-supported-paragraph-text")
    return tuple(blocks), issues


def _paragraph_style_id(paragraph: ElementTree.Element) -> str | None:
    properties = first_child(paragraph, "pPr")
    return string_attribute(first_child(properties, "pStyle"), WORD_NAMESPACE, "val")


def _paragraph_numbering(
    paragraph: ElementTree.Element, styles: dict[str, DocxStyle]
) -> tuple[int | None, int | None]:
    properties = first_child(paragraph, "pPr")
    numbering_properties = first_child(properties, "numPr")
    num_id = integer_attribute(first_child(numbering_properties, "numId"), WORD_NAMESPACE, "val")
    level = integer_attribute(first_child(numbering_properties, "ilvl"), WORD_NAMESPACE, "val")
    if num_id is None:
        style_id = _paragraph_style_id(paragraph)
        style = styles.get(style_id or "")
        num_id = style.num_id if style is not None else None
    return num_id, level
