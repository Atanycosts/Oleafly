"""Declared section geometry and explicit paragraph breaks."""

from __future__ import annotations

from typing import Literal
from xml.etree import ElementTree

from research_file_workbench.docx.models import (
    DocxBreak,
    DocxRelationship,
    DocxSection,
)
from research_file_workbench.docx.xml_support import (
    OFFICE_RELATIONSHIP_NAMESPACE,
    WORD_NAMESPACE,
    first_child,
    integer_attribute,
    iter_selected,
    on_off_value,
    paragraph_content,
    paragraphs,
    selected_children,
    string_attribute,
    tag_local_name,
)


def read_layout(
    xml_roots: dict[str, ElementTree.Element],
    relationships: tuple[DocxRelationship, ...] = (),
) -> tuple[tuple[DocxSection, ...], tuple[DocxBreak, ...], list[str]]:
    """Preserve declared sections and assign each break to its own paragraph."""
    root = xml_roots.get("word/document.xml")
    if root is None:
        return (), (), ["missing-document-layout"]
    issues: list[str] = []
    sections: list[DocxSection] = []
    breaks: list[DocxBreak] = []
    parent_map = {
        id(child): parent for parent in iter_selected(root) for child in selected_children(parent)
    }
    source_paragraphs = paragraphs(root)
    paragraph_locators = {
        id(paragraph): f"word/document.xml#paragraph[{index}]"
        for index, (paragraph, _) in enumerate(source_paragraphs, start=1)
    }
    relation_map = {
        (relation.source_part, relation.relationship_id): relation for relation in relationships
    }
    # Sections close at a paragraph-level sectPr (the anchor paragraph is the section's last)
    # or at the body-level sectPr. Body-level prose paragraphs of each section are retained so
    # the section's declared body type size and line spacing can be observed; table and
    # textbox paragraphs are excluded from that observation.
    body = first_child(root, "body")
    section_buckets: list[
        tuple[ElementTree.Element, ElementTree.Element | None, list[ElementTree.Element]]
    ] = []
    current_bucket: list[ElementTree.Element] = []
    if body is not None:
        for child in selected_children(body):
            local_name = tag_local_name(child.tag)
            if local_name == "p":
                current_bucket.append(child)
                p_pr = first_child(child, "pPr")
                sect = first_child(p_pr, "sectPr") if p_pr is not None else None
                if sect is not None:
                    section_buckets.append((sect, child, current_bucket))
                    current_bucket = []
            elif local_name == "sdt":
                # Structured document tags wrap real body paragraphs; their content belongs
                # to the section being accumulated.
                content = first_child(child, "sdtContent")
                for wrapped in selected_children(content) if content is not None else ():
                    wrapped_local = tag_local_name(wrapped.tag)
                    if wrapped_local == "p":
                        current_bucket.append(wrapped)
                    elif wrapped_local == "sdt":
                        issues.append("section-bucket-skipped-nested-sdt")
            elif local_name == "sectPr":
                section_buckets.append((child, None, current_bucket))
                current_bucket = []
    declared_sections = sum(
        1 for element in iter_selected(root) if tag_local_name(element.tag) == "sectPr"
    )
    if declared_sections != len(section_buckets):
        issues.append(f"sections-outside-body-buckets:{declared_sections - len(section_buckets)}")
    for section_index, (section, anchor, bucket_paragraphs) in enumerate(section_buckets, start=1):
        body_font_size_halfpoints, body_line_spacing_twips = _body_format_observation(
            bucket_paragraphs
        )
        page_size = first_child(section, "pgSz")
        margins = first_child(section, "pgMar")
        columns = first_child(section, "cols")
        parent = parent_map.get(id(section))
        attached_parent = (
            parent
            if anchor is not None
            else parent_map.get(id(parent))
            if parent is not None
            else None
        )
        attached_to: Literal["paragraph", "body"] = "paragraph" if anchor is not None else "body"
        attached_locator = (
            paragraph_locators.get(id(anchor))
            if anchor is not None
            else paragraph_locators.get(id(attached_parent))
        )
        header_relationship_ids = _section_relationship_ids(
            section, "headerReference", relation_map
        )
        footer_relationship_ids = _section_relationship_ids(
            section, "footerReference", relation_map
        )
        section_type = string_attribute(first_child(section, "type"), WORD_NAMESPACE, "val")
        unconfirmed_fields = tuple(
            field_name
            for field_name, value in (
                ("orientation", string_attribute(page_size, WORD_NAMESPACE, "orient")),
                ("columns", integer_attribute(columns, WORD_NAMESPACE, "num")),
                ("section_type", section_type),
            )
            if value is None
        )
        sections.append(
            DocxSection(
                part_path="word/document.xml",
                node_locator=f"word/document.xml#sectPr[{section_index}]",
                section_index=section_index,
                attached_to=attached_to,
                page_width_twips=integer_attribute(page_size, WORD_NAMESPACE, "w"),
                page_height_twips=integer_attribute(page_size, WORD_NAMESPACE, "h"),
                orientation=string_attribute(page_size, WORD_NAMESPACE, "orient"),
                top_margin_twips=integer_attribute(margins, WORD_NAMESPACE, "top"),
                right_margin_twips=integer_attribute(margins, WORD_NAMESPACE, "right"),
                bottom_margin_twips=integer_attribute(margins, WORD_NAMESPACE, "bottom"),
                left_margin_twips=integer_attribute(margins, WORD_NAMESPACE, "left"),
                header_margin_twips=integer_attribute(margins, WORD_NAMESPACE, "header"),
                footer_margin_twips=integer_attribute(margins, WORD_NAMESPACE, "footer"),
                gutter_twips=integer_attribute(margins, WORD_NAMESPACE, "gutter"),
                columns=integer_attribute(columns, WORD_NAMESPACE, "num"),
                column_space_twips=integer_attribute(columns, WORD_NAMESPACE, "space"),
                body_font_size_halfpoints=body_font_size_halfpoints,
                body_line_spacing_twips=body_line_spacing_twips,
                attached_locator=attached_locator,
                section_type=section_type,
                header_relationship_ids=header_relationship_ids,
                footer_relationship_ids=footer_relationship_ids,
                unconfirmed_fields=unconfirmed_fields,
            )
        )
    for paragraph_index, (paragraph, _in_textbox) in enumerate(paragraphs(root), start=1):
        for break_index, element in enumerate(
            (item for item in paragraph_content(paragraph) if tag_local_name(item.tag) == "br"),
            start=1,
        ):
            breaks.append(
                DocxBreak(
                    part_path="word/document.xml",
                    node_locator=f"word/document.xml#paragraph[{paragraph_index}]/break[{break_index}]",
                    break_type=string_attribute(element, WORD_NAMESPACE, "type"),
                )
            )
    return tuple(sections), tuple(breaks), issues


def _body_format_observation(
    paragraphs: list[ElementTree.Element],
) -> tuple[int | None, int | None]:
    """Return the dominant declared run size and line spacing of body-level paragraphs.

    The walk follows the same selected-branch discipline as the text projection: nested
    paragraphs, textboxes, deleted runs and hidden runs never contribute, and a
    paragraph's own mark run is included (it declares the height of an otherwise empty
    paragraph). Ties resolve to the smaller value for determinism. ``lineRule="auto"`` is
    a multiple of single spacing rather than a point measure and is excluded; a section
    mixing exact and atLeast declarations reports no spacing because the two are not the
    same promise.
    """
    sizes: dict[int, int] = {}
    spacings: dict[int, int] = {}
    spacing_rules: set[str] = set()

    def walk(element: ElementTree.Element, *, deleted: bool, hidden: bool, is_root: bool) -> None:
        local = tag_local_name(element.tag)
        if not is_root and local in {"p", "txbxContent"}:
            return
        if local == "del":
            deleted = True
        if local == "r":
            r_pr = first_child(element, "rPr")
            vanish = first_child(r_pr, "vanish") if r_pr is not None else None
            if vanish is not None and on_off_value(vanish):
                hidden = True
        if local == "sz" and not deleted and not hidden:
            value = _non_negative_int(string_attribute(element, WORD_NAMESPACE, "val"))
            if value is not None:
                sizes[value] = sizes.get(value, 0) + 1
        if local == "spacing" and not deleted and not hidden:
            rule = string_attribute(element, WORD_NAMESPACE, "lineRule")
            value = _non_negative_int(string_attribute(element, WORD_NAMESPACE, "line"))
            if rule in {"exact", "atLeast"} and value is not None:
                spacings[value] = spacings.get(value, 0) + 1
                spacing_rules.add(rule)
        for child in selected_children(element):
            walk(child, deleted=deleted, hidden=hidden, is_root=False)

    for paragraph in paragraphs:
        walk(paragraph, deleted=False, hidden=False, is_root=True)
    font = max(sizes.items(), key=lambda item: (item[1], -item[0]))[0] if sizes else None
    spacing = max(spacings.items(), key=lambda item: (item[1], -item[0]))[0] if spacings else None
    if spacing is not None and len(spacing_rules) > 1:
        # Exact and atLeast values are both point measures but not the same promise; the
        # dominant value is withheld so the reviewer sees an unknown instead of a mixed
        # aggregate.
        spacing = None
    return font, spacing


def _non_negative_int(value: str | None) -> int | None:
    """Parse a non-negative decimal integer, refusing empty or non-ASCII digit input."""
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def _section_relationship_ids(
    section: ElementTree.Element,
    reference_name: str,
    relation_map: dict[tuple[str, str], DocxRelationship],
) -> tuple[str, ...]:
    relationship_ids: list[str] = []
    for child in selected_children(section):
        if tag_local_name(child.tag) != reference_name:
            continue
        relationship_id = string_attribute(child, OFFICE_RELATIONSHIP_NAMESPACE, "id")
        if relationship_id is not None and ("word/document.xml", relationship_id) in relation_map:
            relationship_ids.append(relationship_id)
    return tuple(relationship_ids)
