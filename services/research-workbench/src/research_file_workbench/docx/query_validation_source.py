"""Source identity checks for persisted DOCX query responses."""

from __future__ import annotations

from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.docx.read_receipt import ReadReceipt
from research_file_workbench.docx.report import COVERAGE_STATUS, READER_VERSION


def validate_source_header(
    result: DocxReadResult, response: JsonObject, receipt: ReadReceipt
) -> JsonObject:
    """Validate source identity and return the exact persisted query scope."""
    from research_file_workbench.docx.query import QUERY_VERSION, ReadQueryError, _source

    if (
        response.get("reader_version") != READER_VERSION
        or response.get("query_version") != QUERY_VERSION
        or response.get("status") != COVERAGE_STATUS
        or receipt.method_version != QUERY_VERSION
        or response.get("source") != _source(result)
    ):
        raise ReadQueryError("Delivered response source or method does not match the reader")
    scope = response.get("query_scope")
    if not isinstance(scope, dict) or set(scope) != {
        "region",
        "object_type",
        "object_id",
        "page_number",
    }:
        raise ReadQueryError("Delivered response has an invalid query scope")
    return cast(JsonObject, scope)
