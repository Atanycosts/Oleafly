"""Immutable DOCX source observations and parsing errors."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

PartStatus = Literal["registered", "parsed", "failed"]


class DocxReadError(ValueError):
    """Raised when a source cannot be treated as a DOCX package."""


@dataclass(frozen=True)
class DocxPart:
    """One ZIP part registered during a read-only package inventory."""

    part_path: str
    size: int
    sha256: str
    content_type: str | None
    status: PartStatus


@dataclass(frozen=True)
class DocxRelationship:
    """One package relationship, including unresolved and external targets."""

    source_part: str
    relationship_id: str
    relationship_type: str
    target: str
    target_mode: str | None
    resolved_target: str | None


@dataclass(frozen=True)
class DocxTextBlock:
    """Source text observed in one Word paragraph without interpreting page layout.

    ``byte_start`` and ``byte_end`` locate the paragraph element inside the part named by
    ``part_path``, with ``byte_end`` exclusive. They are absent when positions could not be
    established, which is reported as an issue rather than approximated; an offset is only
    meaningful against the exact retained part bytes.
    """

    region: str
    part_path: str
    node_locator: str
    text: str
    parse_status: Literal["parsed", "unverified"]
    hidden: bool
    contains_field_code: bool
    contains_omml: bool
    revision_state: Literal["none", "inserted", "deleted", "mixed"]
    paragraph_style_id: str | None = None
    caption: bool = False
    numbering_id: int | None = None
    numbering_level: int | None = None
    byte_start: int | None = None
    byte_end: int | None = None


@dataclass(frozen=True)
class DocxTableCell:
    """One table cell with explicit grid and vertical-merge properties."""

    row_index: int
    cell_index: int
    node_locator: str
    text: str
    grid_span: int
    vertical_merge: Literal["none", "restart", "continue"]


@dataclass(frozen=True)
class DocxTable:
    """A table grid extracted without inferring rendered page geometry."""

    part_path: str
    node_locator: str
    grid_widths_twips: tuple[int, ...]
    rows: tuple[tuple[DocxTableCell, ...], ...]
    repeat_header_rows: tuple[int, ...]


@dataclass(frozen=True)
class DocxImage:
    """An inline or anchored drawing and its referenced package resource."""

    part_path: str
    node_locator: str
    container: Literal["inline", "anchored", "unknown"]
    relationship_id: str | None
    resource_part: str | None
    width_emu: int | None
    height_emu: int | None
    docpr_id: str | None
    name: str | None
    wrap_type: str | None
    parse_status: Literal["parsed", "partial", "unsupported"]
    paragraph_locator: str | None = None


@dataclass(frozen=True)
class DocxMathObject:
    """Raw OMML source with an explicit inline or display classification."""

    part_path: str
    node_locator: str
    kind: Literal["inline", "display"]
    text: str
    omml_source: str
    paragraph_locator: str | None = None


@dataclass(frozen=True)
class DocxField:
    """A field boundary sequence and its raw instruction text."""

    part_path: str
    node_locator: str
    field_kind: str
    instruction: str
    boundary_sequence: tuple[str, ...]
    result_text: str
    nested_level: int
    occurrence_index: int = 1
    protected_reason: str = "Field boundary is preserved; field refresh is not performed."


@dataclass(frozen=True)
class DocxSection:
    """Declared section properties; absent attributes remain unknown."""

    part_path: str
    node_locator: str
    section_index: int
    attached_to: Literal["paragraph", "body"]
    page_width_twips: int | None
    page_height_twips: int | None
    orientation: str | None
    top_margin_twips: int | None
    right_margin_twips: int | None
    bottom_margin_twips: int | None
    left_margin_twips: int | None
    header_margin_twips: int | None
    footer_margin_twips: int | None
    gutter_twips: int | None
    columns: int | None
    column_space_twips: int | None
    body_font_size_halfpoints: int | None = None
    body_line_spacing_twips: int | None = None
    attached_locator: str | None = None
    section_type: str | None = None
    header_relationship_ids: tuple[str, ...] = ()
    footer_relationship_ids: tuple[str, ...] = ()
    unconfirmed_fields: tuple[str, ...] = ()


@dataclass(frozen=True)
class DocxBreak:
    """An explicit page, column or line break in a paragraph."""

    part_path: str
    node_locator: str
    break_type: str | None


@dataclass(frozen=True)
class DocxComplexObject:
    """A complex object registered without executing or semantically parsing it."""

    part_path: str
    node_locator: str
    kind: Literal["chart", "ole", "group_drawing", "unknown_extension"]
    relationship_ids: tuple[str, ...]
    related_parts: tuple[str, ...]
    available_preview: tuple[str, ...]
    parse_status: Literal["registered", "unsupported"]
    limitations: tuple[str, ...] = ()
    metadata: tuple[tuple[str, str], ...] = ()
    paragraph_locator: str | None = None


@dataclass(frozen=True)
class DocxReference:
    """A reference, anchor or relationship-backed target preserved from OOXML."""

    part_path: str
    node_locator: str
    kind: Literal[
        "footnote_reference",
        "endnote_reference",
        "comment_anchor",
        "bookmark",
        "hyperlink",
    ]
    reference_id: str | None
    reference_name: str | None
    relationship_id: str | None
    target_part: str | None
    parse_status: Literal["parsed", "partial", "unsupported"]
    limitations: tuple[str, ...]
    paragraph_locator: str | None = None


@dataclass(frozen=True)
class DocxStyle:
    """A style declaration and its resolved inheritance chain."""

    style_id: str
    style_type: str | None
    based_on: str | None
    source_chain: tuple[str, ...]
    font_ascii: str | None
    font_size_pt: float | None
    italic: bool | None
    space_after_twips: int | None
    num_id: int | None
    computed_sources: tuple[tuple[str, str], ...]
    unconfirmed_fields: tuple[str, ...]


@dataclass(frozen=True)
class DocxNumbering:
    """Numbering definition binding a concrete num id to an abstract definition."""

    num_id: int
    abstract_num_id: int | None
    levels: tuple[tuple[int, str | None, str | None], ...]
    parse_status: Literal["parsed", "partial", "unsupported"]
    limitations: tuple[str, ...]


@dataclass(frozen=True)
class DocxUnsupportedRecord:
    """A structured unsupported or broken observation kept for audit."""

    source_location: str
    kind: Literal[
        "unknown_namespace",
        "broken_relationship",
        "missing_relationship",
    ]
    relationship_id: str | None
    failure_reason: str
    related_part: str | None
    parse_status: Literal["partial", "unsupported", "failed"]
    available_page_evidence: tuple[str, ...]
    limitations: tuple[str, ...]


@dataclass(frozen=True)
class DocxParagraphScope:
    """Selected source paragraph identity, including paragraphs without projected text."""

    node_locator: str
    part_path: str
    region: str
    region_index: int
    body_paragraph_index: int | None
    body_container_index: int | None = None


@dataclass(frozen=True)
class DocxReadResult:
    """Immutable result of the first read-only DOCX package slice."""

    source_path: str
    source_sha256: str
    parts: tuple[DocxPart, ...]
    relationships: tuple[DocxRelationship, ...]
    text_blocks: tuple[DocxTextBlock, ...]
    tables: tuple[DocxTable, ...]
    images: tuple[DocxImage, ...]
    math_objects: tuple[DocxMathObject, ...]
    fields: tuple[DocxField, ...]
    sections: tuple[DocxSection, ...]
    breaks: tuple[DocxBreak, ...]
    complex_objects: tuple[DocxComplexObject, ...]
    references: tuple[DocxReference, ...]
    styles: tuple[DocxStyle, ...]
    numbering: tuple[DocxNumbering, ...]
    unsupported_records: tuple[DocxUnsupportedRecord, ...]
    issues: tuple[str, ...]
    paragraph_scopes: tuple[DocxParagraphScope, ...] = ()
