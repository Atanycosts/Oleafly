"""JSON serializers for the immutable observations returned by the DOCX reader.

Each serializer preserves source observations and explicitly records the
limitations of any projection.  Report assembly and coverage accounting live
in :mod:`research_file_workbench.docx.report` and
:mod:`research_file_workbench.docx.report_coverage` respectively.
"""

from __future__ import annotations

from collections.abc import Iterable

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import (
    DocxBreak,
    DocxComplexObject,
    DocxField,
    DocxImage,
    DocxMathObject,
    DocxNumbering,
    DocxPart,
    DocxReference,
    DocxRelationship,
    DocxSection,
    DocxTable,
    DocxTableCell,
    DocxTextBlock,
    DocxTextProjection,
    DocxUnsupportedRecord,
)
from research_file_workbench.docx.package_query import xml_element_node_address


def _part_to_json(item: DocxPart) -> JsonObject:
    return {
        "part_path": item.part_path,
        "size": item.size,
        "sha256": item.sha256,
        "content_type": item.content_type,
        "parse_status": "unverified" if item.status == "registered" else item.status,
        "inventory_status": item.status,
    }


def _relationship_to_json(item: DocxRelationship) -> JsonObject:
    if item.target_mode == "External":
        parse_status = "external"
    elif item.resolved_target is None:
        parse_status = "unresolved"
    else:
        parse_status = "resolved"
    limitations: list[str] = []
    if parse_status == "external":
        limitations.append("External target is recorded but not fetched or validated.")
    elif parse_status == "unresolved":
        limitations.append("Internal target is missing from the package.")
    return {
        "source_part": item.source_part,
        "relationship_id": item.relationship_id,
        "relationship_type": item.relationship_type,
        "target": item.target,
        "target_mode": item.target_mode,
        "resolved_target": item.resolved_target,
        "parse_status": "parsed" if parse_status == "resolved" else "partial",
        "resolution_status": parse_status,
        "limitations": limitations,
    }


def _reading_text(source: str, accepted: DocxTextProjection | None) -> JsonObject:
    if accepted is None:
        return {"text": source, "text_projection": "accepted_revisions"}
    if accepted.text is None:
        return {
            "text": "",
            "text_projection": "unavailable",
            "text_projection_reason": accepted.reason,
            "source_text": source,
        }
    return {"text": accepted.text, "text_projection": "accepted_revisions", "source_text": source}


def _text_block_to_json(item: DocxTextBlock, *, for_query: bool) -> JsonObject:
    return {
        "region": item.region,
        "part_path": item.part_path,
        "node_locator": item.node_locator,
        **(
            _reading_text(item.text, item.accepted_projection) if for_query else {"text": item.text}
        ),
        "parse_status": item.parse_status,
        "hidden": item.hidden,
        "contains_field_code": item.contains_field_code,
        "contains_omml": item.contains_omml,
        "revision_state": item.revision_state,
        "paragraph_style_id": item.paragraph_style_id,
        "caption": item.caption,
        "numbering_id": item.numbering_id,
        "numbering_level": item.numbering_level,
        # Offsets into the retained part bytes, with byte_end exclusive. Absent means the
        # paragraph could not be located in the source, which is reported through issues rather
        # than filled with an approximation.
        "byte_start": item.byte_start,
        "byte_end": item.byte_end,
    }


def _table_to_json(item: DocxTable, *, for_query: bool) -> JsonObject:
    return {
        "part_path": item.part_path,
        "node_locator": item.node_locator,
        "parse_status": "parsed",
        "grid_widths_twips": list(item.grid_widths_twips),
        "rows": [
            [_table_cell_to_json(cell, for_query=for_query) for cell in row] for row in item.rows
        ],
        "repeat_header_rows": list(item.repeat_header_rows),
        "limitations": ["Rendered table geometry and style inheritance are not computed."],
    }


def _table_cell_to_json(item: DocxTableCell, *, for_query: bool) -> JsonObject:
    return {
        "row_index": item.row_index,
        "cell_index": item.cell_index,
        "node_locator": item.node_locator,
        **(
            _reading_text(item.text, item.accepted_projection) if for_query else {"text": item.text}
        ),
        "grid_span": item.grid_span,
        "vertical_merge": item.vertical_merge,
        "parse_status": "parsed",
    }


def _image_to_json(item: DocxImage) -> JsonObject:
    limitations: list[str] = []
    if item.parse_status != "parsed":
        limitations.append("Drawing metadata is incomplete and requires independent review.")
    limitations.append("Caption association and rendered page placement are not resolved.")
    return {
        "part_path": item.part_path,
        "node_locator": item.node_locator,
        "paragraph_locator": item.paragraph_locator,
        "container": item.container,
        "relationship_id": item.relationship_id,
        "resource_part": item.resource_part,
        "width_emu": item.width_emu,
        "height_emu": item.height_emu,
        "docpr_id": item.docpr_id,
        "name": item.name,
        "wrap_type": item.wrap_type,
        "parse_status": item.parse_status,
        "limitations": limitations,
    }


def _math_to_json(item: DocxMathObject) -> JsonObject:
    return {
        "part_path": item.part_path,
        "node_locator": item.node_locator,
        "paragraph_locator": item.paragraph_locator,
        "kind": item.kind,
        "text": item.text,
        "omml_source": item.omml_source,
        "parse_status": "parsed",
        "page_refs": [],
        "limitations": [
            "OMML source is preserved; semantic conversion and page mapping are deferred."
        ],
    }


def _field_to_json(item: DocxField) -> JsonObject:
    return {
        "part_path": item.part_path,
        "node_locator": item.node_locator,
        "field_kind": item.field_kind,
        "instruction": item.instruction,
        "boundary_sequence": list(item.boundary_sequence),
        "result_text": item.result_text,
        "nested_level": item.nested_level,
        "occurrence_index": item.occurrence_index,
        "parse_status": "parsed",
        "protected_reason": item.protected_reason,
        "limitations": [
            "Field instruction semantics and provider-specific metadata are not interpreted."
        ],
    }


def _section_to_json(item: DocxSection) -> JsonObject:
    declared_values: JsonObject = {
        "page_width_twips": item.page_width_twips,
        "page_height_twips": item.page_height_twips,
        "orientation": item.orientation,
        "top_margin_twips": item.top_margin_twips,
        "right_margin_twips": item.right_margin_twips,
        "bottom_margin_twips": item.bottom_margin_twips,
        "left_margin_twips": item.left_margin_twips,
        "header_margin_twips": item.header_margin_twips,
        "footer_margin_twips": item.footer_margin_twips,
        "gutter_twips": item.gutter_twips,
        "columns": item.columns,
        "column_space_twips": item.column_space_twips,
        "body_font_size_halfpoints": item.body_font_size_halfpoints,
        "body_line_spacing_twips": item.body_line_spacing_twips,
    }
    return {
        "part_path": item.part_path,
        "node_locator": item.node_locator,
        "section_index": item.section_index,
        "attached_to": item.attached_to,
        "attached_locator": item.attached_locator,
        "section_type": item.section_type,
        "header_relationship_ids": list(item.header_relationship_ids),
        "footer_relationship_ids": list(item.footer_relationship_ids),
        "parse_status": "partial",
        "declared_values": declared_values,
        "computed_values": None,
        "source_chain": [item.node_locator],
        "unconfirmed_fields": list(
            item.unconfirmed_fields
            or ("computed_page_geometry", "style_inheritance", "rendered_columns")
        ),
        "limitations": [
            "Only declared section properties are read; computed layout is unavailable."
        ],
    }


def _break_to_json(item: DocxBreak) -> JsonObject:
    return {
        "part_path": item.part_path,
        "node_locator": item.node_locator,
        "break_type": item.break_type,
        "parse_status": "parsed",
    }


def _complex_object_to_json(item: DocxComplexObject, source_sha256: str) -> JsonObject:
    limitations = _unique((*item.limitations, "Object semantics are not interpreted or executed."))
    return {
        "part_path": item.part_path,
        "node_locator": item.node_locator,
        "node_address": xml_element_node_address(source_sha256, item.part_path, item.element_path),
        "paragraph_locator": item.paragraph_locator,
        "kind": item.kind,
        "in_selected_branch": item.in_selected_branch,
        "relationship_ids": list(item.relationship_ids),
        "related_parts": list(item.related_parts),
        "available_preview": list(item.available_preview),
        "parse_status": ("unsupported" if item.parse_status == "registered" else item.parse_status),
        "registration_status": item.parse_status,
        "limitations": limitations,
        "metadata": {key: value for key, value in item.metadata},
    }


def _reference_to_json(item: DocxReference, *, for_query: bool) -> JsonObject:
    result: JsonObject = {
        "part_path": item.part_path,
        "node_locator": item.node_locator,
        "paragraph_locator": item.paragraph_locator,
        "kind": item.kind,
        "reference_id": item.reference_id,
        "reference_name": item.reference_name,
        "relationship_id": item.relationship_id,
        "target_part": item.target_part,
        "parse_status": item.parse_status,
        "limitations": list(item.limitations),
    }
    if not for_query or item.kind != "comment_anchor":
        return result
    limitations = [
        value
        for value in item.limitations
        if value != "Reference target content is not semantically interpreted."
    ]
    if (comment := item.comment) is None:
        result["parse_status"] = "partial"
        result["comment"] = None
        limitations.append("Comment body could not be matched to a unique related Word comment.")
    else:
        result["comment"] = {
            "author": comment.author,
            "date": comment.date,
            "node_locator": comment.node_locator,
            **_reading_text(comment.text, comment.accepted_projection),
        }
    result["limitations"] = limitations
    return result


def _numbering_to_json(item: DocxNumbering) -> JsonObject:
    return {
        "num_id": item.num_id,
        "abstract_num_id": item.abstract_num_id,
        "levels": [
            {"level": level, "format": format_name, "text": text}
            for level, format_name, text in item.levels
        ],
        "parse_status": item.parse_status,
        "limitations": list(item.limitations),
    }


def _unsupported_record_to_json(item: DocxUnsupportedRecord) -> JsonObject:
    return {
        "source_location": item.source_location,
        "kind": item.kind,
        "relationship_id": item.relationship_id,
        "failure_reason": item.failure_reason,
        "related_part": item.related_part,
        "parse_status": item.parse_status,
        "available_page_evidence": list(item.available_page_evidence),
        "limitations": list(item.limitations),
    }


def _unique(values: Iterable[str]) -> list[str]:
    found: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in found:
            found.add(value)
            result.append(value)
    return result
