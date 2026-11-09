"""Pagination and continuation checks for DOCX query delivery."""

from __future__ import annotations

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.docx.query_validation_selection import DeliverySelection
from research_file_workbench.docx.read_receipt import ReadPagination, ReadReceipt
from research_file_workbench.docx.report import READER_VERSION


def validate_pagination(
    result: DocxReadResult,
    response: JsonObject,
    receipt: ReadReceipt,
    delivery: DeliverySelection,
    scope: JsonObject,
    pagination: ReadPagination,
    offset: int,
    returned_count: int,
    has_more: bool,
    baseline_id: str | None,
    page_mapping: JsonObject | None,
) -> None:
    """Validate pagination facts, continuation binding, and receipt dependencies."""
    from research_file_workbench.docx.query import (
        CONTINUATION_AVAILABLE,
        CONTINUATION_EXHAUSTED,
        QUERY_VERSION,
        ReadQueryError,
    )
    from research_file_workbench.docx.query_validation import encode_cursor, query_binding

    if (
        pagination.total_ranges != len(delivery.selected)
        or pagination.has_more != has_more
        or receipt.truncation != bool(offset or has_more)
    ):
        raise ReadQueryError("Delivered pagination does not describe the selected object slice")
    expected_delivery = CONTINUATION_AVAILABLE if has_more else CONTINUATION_EXHAUSTED
    if response.get("selection_delivery") != expected_delivery:
        raise ReadQueryError("Delivered selection state differs from its selected object slice")
    binding = query_binding(result, scope, delivery.query.page_size, baseline_id, page_mapping)
    expected_cursor = encode_cursor(binding, offset + returned_count) if has_more else None
    if pagination.next_cursor != expected_cursor:
        raise ReadQueryError("Delivered continuation cursor differs from its selected object slice")
    if not {READER_VERSION, QUERY_VERSION, binding}.issubset(receipt.dependencies):
        raise ReadQueryError("Delivered receipt is not bound to the selected source and query")
