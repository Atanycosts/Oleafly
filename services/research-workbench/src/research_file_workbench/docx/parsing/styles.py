"""Declared style inheritance and numbering definitions."""

from __future__ import annotations

from xml.etree import ElementTree

from research_file_workbench.docx.models import (
    DocxNumbering,
    DocxStyle,
)
from research_file_workbench.docx.xml_support import (
    WORD_NAMESPACE,
    first_child,
    integer_attribute,
    string_attribute,
    tag_local_name,
)


def read_styles(
    xml_roots: dict[str, ElementTree.Element],
) -> tuple[tuple[DocxStyle, ...], list[str]]:
    """Resolve available style declarations and report broken inheritance chains."""
    root = xml_roots.get("word/styles.xml")
    if root is None:
        return (), []
    style_elements: dict[str, ElementTree.Element] = {}
    for element in root:
        style_id = string_attribute(element, WORD_NAMESPACE, "styleId")
        if tag_local_name(element.tag) == "style" and style_id is not None:
            style_elements[style_id] = element
    styles: list[DocxStyle] = []
    issues: list[str] = []
    for style_id, element in style_elements.items():
        chain: list[str] = []
        incomplete_chain = False
        current_id: str | None = style_id
        while current_id is not None:
            if current_id in chain:
                issues.append(f"style-inheritance-cycle:{style_id}")
                incomplete_chain = True
                break
            current = style_elements.get(current_id)
            if current is None:
                issues.append(f"missing-style-base:{style_id}:{current_id}")
                incomplete_chain = True
                break
            chain.append(current_id)
            current_id = string_attribute(first_child(current, "basedOn"), WORD_NAMESPACE, "val")
        values: dict[str, object] = {}
        sources: dict[str, str] = {}
        for chain_id in chain:
            chain_element = style_elements[chain_id]
            properties = _style_properties(chain_element)
            for field_name, value in properties.items():
                if field_name not in values and value is not None:
                    values[field_name] = value
                    sources[field_name] = chain_id
        unconfirmed = tuple(
            field_name
            for field_name in (
                "font_ascii",
                "font_size_pt",
                "italic",
                "space_after_twips",
                "num_id",
            )
            if field_name not in values
        )
        if incomplete_chain:
            unconfirmed += ("style_inheritance",)
        font_ascii_value = values.get("font_ascii")
        font_size_value = values.get("font_size_pt")
        italic_value = values.get("italic")
        space_after_value = values.get("space_after_twips")
        num_id_value = values.get("num_id")
        styles.append(
            DocxStyle(
                style_id=style_id,
                style_type=string_attribute(element, WORD_NAMESPACE, "type"),
                based_on=string_attribute(first_child(element, "basedOn"), WORD_NAMESPACE, "val"),
                source_chain=tuple(chain),
                font_ascii=font_ascii_value if isinstance(font_ascii_value, str) else None,
                font_size_pt=(
                    float(font_size_value) if isinstance(font_size_value, (int, float)) else None
                ),
                italic=italic_value if isinstance(italic_value, bool) else None,
                space_after_twips=(
                    space_after_value if isinstance(space_after_value, int) else None
                ),
                num_id=num_id_value if isinstance(num_id_value, int) else None,
                computed_sources=tuple(sorted(sources.items())),
                unconfirmed_fields=unconfirmed,
            )
        )
    return tuple(styles), issues


def read_numbering(
    xml_roots: dict[str, ElementTree.Element],
) -> tuple[tuple[DocxNumbering, ...], list[str]]:
    """Read concrete numbering bindings without discarding a zero abstract ID."""
    root = xml_roots.get("word/numbering.xml")
    if root is None:
        return (), []
    abstract_levels: dict[int, tuple[tuple[int, str | None, str | None], ...]] = {}
    for abstract in (item for item in root if tag_local_name(item.tag) == "abstractNum"):
        abstract_id = integer_attribute(abstract, WORD_NAMESPACE, "abstractNumId")
        if abstract_id is None:
            continue
        level_records: list[tuple[int, str | None, str | None]] = []
        for level in (item for item in abstract if tag_local_name(item.tag) == "lvl"):
            level_id = integer_attribute(level, WORD_NAMESPACE, "ilvl")
            number_format = string_attribute(first_child(level, "numFmt"), WORD_NAMESPACE, "val")
            level_text = string_attribute(first_child(level, "lvlText"), WORD_NAMESPACE, "val")
            if level_id is not None:
                level_records.append((level_id, number_format, level_text))
        abstract_levels[abstract_id] = tuple(level_records)
    numbering: list[DocxNumbering] = []
    for number in (item for item in root if tag_local_name(item.tag) == "num"):
        num_id = integer_attribute(number, WORD_NAMESPACE, "numId")
        abstract_id = integer_attribute(first_child(number, "abstractNumId"), WORD_NAMESPACE, "val")
        if num_id is None:
            continue
        levels = abstract_levels.get(abstract_id, ()) if abstract_id is not None else ()
        numbering.append(
            DocxNumbering(
                num_id=num_id,
                abstract_num_id=abstract_id,
                levels=levels,
                parse_status="parsed" if abstract_id in abstract_levels else "partial",
                limitations=()
                if abstract_id in abstract_levels
                else ("Referenced abstract numbering definition is missing.",),
            )
        )
    return tuple(numbering), []


def _style_properties(element: ElementTree.Element) -> dict[str, object]:
    properties: dict[str, object] = {}
    run_properties = first_child(element, "rPr")
    paragraph_properties = first_child(element, "pPr")
    fonts = first_child(run_properties, "rFonts")
    font_ascii = string_attribute(fonts, WORD_NAMESPACE, "ascii")
    if font_ascii is None:
        font_ascii = string_attribute(fonts, WORD_NAMESPACE, "hAnsi")
    if font_ascii is not None:
        properties["font_ascii"] = font_ascii
    font_size = integer_attribute(first_child(run_properties, "sz"), WORD_NAMESPACE, "val")
    if font_size is not None:
        properties["font_size_pt"] = font_size / 2
    italic = first_child(run_properties, "i")
    if italic is not None:
        value = string_attribute(italic, WORD_NAMESPACE, "val")
        properties["italic"] = value not in {"0", "false", "off"}
    spacing = first_child(paragraph_properties, "spacing")
    space_after = integer_attribute(spacing, WORD_NAMESPACE, "after")
    if space_after is not None:
        properties["space_after_twips"] = space_after
    num_properties = first_child(paragraph_properties, "numPr")
    num_id = integer_attribute(first_child(num_properties, "numId"), WORD_NAMESPACE, "val")
    if num_id is not None:
        properties["num_id"] = num_id
    return properties
