"""Serialization of the read-only S1 DOCX result.

The reader deliberately returns immutable Python records.  This module is the
boundary where those records become a stable, JSON-compatible observation.  It
does not infer layout, resolve field semantics, or turn an unsupported object
into a successful parse.
"""

from __future__ import annotations

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import (
    DocxReadResult,
)
from research_file_workbench.docx.report_coverage import actual_read_ranges, coverage
from research_file_workbench.docx.report_serializers import (
    _break_to_json,
    _complex_object_to_json,
    _field_to_json,
    _image_to_json,
    _math_to_json,
    _numbering_to_json,
    _part_to_json,
    _reference_to_json,
    _relationship_to_json,
    _section_to_json,
    _table_to_json,
    _text_block_to_json,
    _unique,
    _unsupported_record_to_json,
)
from research_file_workbench.docx.report_style_serializers import style_to_json

REPORT_VERSION = "1.0.0"
# 1.5.0 registers selected VML imagedata as an explicit unsupported observation, so an earlier
# observation cannot claim complete support for the document's image resources.
READER_VERSION = "s1-readonly-reader-1.5.0"

# The reader declares unconditional limits (unsupported constructs, part-level regions, no
# page inference), so a DOCX observation is never complete coverage.  This constant is the
# single source for the *coverage* axis shared by the structure report and the query
# response.  Delivery of one requested selection is a separate axis and is never expressed
# here: a caller must not read this value as document completeness.
COVERAGE_STATUS = "partial"


def docx_read_result_to_report(result: DocxReadResult) -> JsonObject:
    """Convert a :class:`DocxReadResult` into a JSON-compatible S1 report.

    Every extracted collection is present even when it has no observations.  A
    missing observation is represented by an explicit coverage status or
    limitation; no empty object is used to claim successful parsing.
    """

    limitations = _unique(
        [
            "This structure report does not itself establish reviewed page mappings.",
            (
                "Style and numbering declarations are read; computed inheritance and rendered "
                "layout remain partial."
            ),
            (
                "Field and OMML semantics are preserved as source observations and are not "
                "interpreted."
            ),
            (
                "Complex embedded objects are registered without executing or semantically "
                "parsing them."
            ),
            *result.issues,
        ]
    )
    return {
        "version": REPORT_VERSION,
        "report_version": REPORT_VERSION,
        "reader_version": READER_VERSION,
        "status": COVERAGE_STATUS,
        "source": {
            "path": result.source_path,
            "sha256": result.source_sha256,
            "version_id": f"sha256-{result.source_sha256}",
            "read_only": True,
        },
        "parts": [_part_to_json(item) for item in result.parts],
        "relationships": [_relationship_to_json(item) for item in result.relationships],
        "text_blocks": [_text_block_to_json(item) for item in result.text_blocks],
        "tables": [_table_to_json(item) for item in result.tables],
        "images": [_image_to_json(item) for item in result.images],
        "math_objects": [_math_to_json(item) for item in result.math_objects],
        "fields": [_field_to_json(item) for item in result.fields],
        "sections": [_section_to_json(item) for item in result.sections],
        "breaks": [_break_to_json(item) for item in result.breaks],
        "complex_objects": [_complex_object_to_json(item) for item in result.complex_objects],
        "references": [_reference_to_json(item) for item in result.references],
        "styles": [style_to_json(item) for item in result.styles],
        "numbering": [_numbering_to_json(item) for item in result.numbering],
        "unsupported_records": [
            _unsupported_record_to_json(item) for item in result.unsupported_records
        ],
        "coverage": coverage(result),
        "limitations": limitations,
        "issues": list(result.issues),
        "actual_read_ranges": actual_read_ranges(result),
    }
