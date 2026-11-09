"""Coverage and exact-read-range projections for DOCX reports."""

from __future__ import annotations

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxReadResult


def coverage(result: DocxReadResult) -> JsonObject:
    """Return capability coverage keyed by the stable capability identifier."""

    items = [*_source_coverage_items(result), *_layout_coverage_items(result)]
    coverage_by_id: JsonObject = {}
    for item in items:
        capability_id = item["capability_id"]
        if not isinstance(capability_id, str):
            raise TypeError("coverage item has no string capability_id")
        coverage_by_id[capability_id] = item
    return coverage_by_id


def _source_coverage_items(result: DocxReadResult) -> list[JsonObject]:
    return [
        _coverage_item(
            "docx-package-inventory",
            "implemented",
            len(result.parts),
            ["source_hash", "part_path", "relationship_target", "parse_status"],
            [],
        ),
        _coverage_item(
            "docx-regional-text",
            "implemented" if result.text_blocks else "partial",
            len(result.text_blocks),
            ["region", "node_locator", "text", "parse_status"],
            ["Empty or unsupported paragraph content is not projected as text."],
        ),
        _coverage_item(
            "docx-basic-table-grid",
            "implemented" if result.tables else "deferred",
            len(result.tables),
            ["node_locator", "grid_width", "merge", "repeat_header", "limitations"],
            ["Rendered geometry and style inheritance are deferred."],
        ),
        _coverage_item(
            "docx-omml-source",
            "partial" if result.math_objects else "deferred",
            len(result.math_objects),
            ["node_locator", "omml_source", "page_refs", "limitations"],
            ["Page references and semantic math conversion are unavailable."],
        ),
        _coverage_item(
            "docx-field-boundaries",
            "implemented" if result.fields else "deferred",
            len(result.fields),
            ["node_locator", "field_boundary", "protected_reason"],
            ["Field provider semantics are not interpreted."],
        ),
        _coverage_item(
            "docx-image-relationships",
            "partial" if result.images else "deferred",
            len(result.images),
            ["node_locator", "resource_relation", "dimensions", "anchor_or_inline"],
            ["Caption association and page placement are unavailable."],
        ),
    ]


def _layout_coverage_items(result: DocxReadResult) -> list[JsonObject]:
    return [
        _coverage_item(
            "docx-styles-and-layout",
            "partial" if result.styles or result.sections or result.breaks else "deferred",
            len(result.styles) + len(result.numbering) + len(result.sections) + len(result.breaks),
            ["declared_value", "computed_value", "source_chain", "unconfirmed_fields"],
            ["Computed page geometry and rendered layout remain unavailable."],
        ),
        _coverage_item(
            "docx-complex-embedded-objects",
            "partial" if result.complex_objects else "deferred",
            len(result.complex_objects),
            ["part_path", "relationship", "available_preview", "limitations"],
            ["Objects are registered; execution and semantic parsing are unsupported."],
        ),
        _coverage_item(
            "docx-unknown-or-broken-content",
            "implemented" if result.unsupported_records else "partial",
            len(result.unsupported_records),
            ["source_location", "relationship", "failure_reason", "available_page_evidence"],
            ["Unknown namespace semantics and page evidence are not resolved."],
        ),
    ]


def actual_read_ranges(result: DocxReadResult) -> list[JsonObject]:
    """Return source, package-part, and located paragraph read ranges."""

    ranges: list[JsonObject] = [
        {
            "range_type": "source_file",
            "locator": result.source_path,
            "sha256": result.source_sha256,
            "parse_status": "parsed",
            "read_status": "read",
        }
    ]
    ranges.extend(
        {
            "range_type": "zip_part",
            "locator": item.part_path,
            "sha256": item.sha256,
            "parse_status": "unverified" if item.status == "registered" else item.status,
            "read_status": "read",
        }
        for item in result.parts
    )
    # A paragraph whose source bytes were located is reported with its exact offsets, so the
    # receipt names the bytes that were read rather than only the part that contains them. A
    # paragraph without offsets is omitted here and its gap stays visible through the issues.
    ranges.extend(
        {
            "range_type": "paragraph",
            "locator": item.node_locator,
            "part_path": item.part_path,
            "start": item.byte_start,
            "end": item.byte_end,
            "parse_status": item.parse_status,
            "read_status": "read",
        }
        for item in result.text_blocks
        if item.byte_start is not None and item.byte_end is not None
    )
    return ranges


def _coverage_item(
    capability_id: str,
    status: str,
    observed_count: int,
    evidence_fields: list[str],
    limitations: list[str],
) -> JsonObject:
    return {
        "capability_id": capability_id,
        "status": status,
        "observed_count": observed_count,
        "evidence_fields": evidence_fields,
        "limitations": limitations,
    }
