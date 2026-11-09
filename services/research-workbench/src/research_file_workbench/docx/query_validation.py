"""Validation helpers for DOCX query responses and continuation state.

The query module owns source indexing and response orchestration.  This module
keeps the response-local contract checks together so the persistence boundary
can reuse exactly the same metadata, cursor, and binding rules without adding
another query implementation.
"""

from __future__ import annotations

import base64
import binascii
import json

from research_file_workbench.common.json_io import JsonObject, decode_json_object
from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.docx.query_index import digest_value
from research_file_workbench.docx.read_receipt import ReadReceipt
from research_file_workbench.docx.report import READER_VERSION


def build_query_metadata(
    result: DocxReadResult,
    report: JsonObject,
    coverage_gaps: list[JsonObject],
    page_number: int | None,
) -> JsonObject:
    """Build source-bound metadata for a query response.

    ``_LIMITATIONS`` remains owned by :mod:`query` because catalog responses
    expose the same list.  Importing it inside the function keeps this helper
    independent at module load time and avoids a query/query-validation cycle.
    """
    from research_file_workbench.docx.query import _LIMITATIONS

    limitations = list(_LIMITATIONS)
    if page_number is not None:
        limitations.append(
            "Reviewed mappings select known objects only; "
            "no complete page or visual read is claimed."
        )
    return {
        "reader_issues": list(result.issues),
        "unsupported_records": report["unsupported_records"],
        "coverage_gaps": coverage_gaps,
        "limitations": limitations,
    }


def encode_cursor(binding: str, offset: int) -> str:
    """Encode a continuation cursor bound to one query selection."""
    payload = json.dumps({"binding": binding, "offset": offset}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def cursor_offset(cursor: str | None, binding: str, page_size: int, total: int) -> int:
    """Decode and validate a continuation cursor for one selected result set."""
    if cursor is None:
        return 0
    from research_file_workbench.docx.query import ReadQueryError

    try:
        payload = decode_json_object(base64.b64decode(cursor, altchars=b"-_", validate=True))
    except (ValueError, UnicodeError, binascii.Error) as exc:
        raise ReadQueryError("Malformed cursor; restart the query without it") from exc
    if set(payload) != {"binding", "offset"}:
        raise ReadQueryError("Cursor has an invalid shape")
    if payload["binding"] != binding:
        raise ReadQueryError("Cursor source, method, selection, page size, or mapping has changed")
    offset = payload["offset"]
    if type(offset) is not int or offset <= 0 or offset >= total or offset % page_size:
        raise ReadQueryError("Cursor offset is outside the selected result pages")
    return offset


def query_binding(
    result: DocxReadResult,
    scope: JsonObject,
    page_size: int,
    baseline_id: str | None,
    page_mapping: JsonObject | None,
) -> str:
    """Return the stable binding for one source, selection, and page size."""
    from research_file_workbench.docx.query import QUERY_VERSION

    return digest_value(
        {
            "source_sha256": result.source_sha256,
            "reader_version": READER_VERSION,
            "query_version": QUERY_VERSION,
            "baseline_id": baseline_id,
            "selection": scope,
            "page_size": page_size,
            "page_mapping_sha256": digest_value(page_mapping) if page_mapping is not None else None,
        }
    )


def validate_query_delivery(
    result: DocxReadResult,
    response: JsonObject,
    receipt: ReadReceipt,
    *,
    page_mapping: JsonObject | None = None,
    baseline_id: str | None = None,
) -> None:
    """Check delivered content and receipt against source observations."""
    from research_file_workbench.docx.query_validation_pagination import validate_pagination
    from research_file_workbench.docx.query_validation_receipt import (
        validate_receipt_header,
        validate_receipt_ranges,
    )
    from research_file_workbench.docx.query_validation_selection import (
        build_delivery_selection,
        slice_selection,
        validate_returned_items,
        validate_selection_metadata,
    )
    from research_file_workbench.docx.query_validation_source import validate_source_header

    scope = validate_source_header(result, response, receipt)
    pagination = validate_receipt_header(response, receipt)
    delivery = build_delivery_selection(result, response, scope, pagination.page_size, page_mapping)
    validate_selection_metadata(result, response, delivery)
    offset, returned, has_more = slice_selection(
        delivery.selected, pagination.page_number, pagination.page_size
    )
    validate_returned_items(response, returned)
    validate_receipt_ranges(result, receipt, delivery.observations, returned)
    validate_pagination(
        result,
        response,
        receipt,
        delivery,
        scope,
        pagination,
        offset,
        len(returned),
        has_more,
        baseline_id,
        page_mapping,
    )
