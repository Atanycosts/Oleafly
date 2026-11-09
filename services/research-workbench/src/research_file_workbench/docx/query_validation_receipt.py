"""Read receipt checks for persisted DOCX query responses."""

from __future__ import annotations

from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.docx.query_index import Observation
from research_file_workbench.docx.read_receipt import ReadPagination, ReadReceipt


def validate_receipt_header(response: dict[str, object], receipt: ReadReceipt) -> ReadPagination:
    """Validate response pagination against its immutable receipt."""
    from research_file_workbench.docx.query import ReadQueryError

    pagination = receipt.pagination
    if pagination is None or response.get("pagination") != pagination.to_json():
        raise ReadQueryError("Delivered pagination differs from its read receipt")
    return pagination


def validate_receipt_ranges(
    result: DocxReadResult,
    receipt: ReadReceipt,
    observations: list[Observation],
    returned: list[Observation],
) -> None:
    """Validate returned and unread receipt ranges against source observations."""
    from research_file_workbench.docx.query import ReadQueryError, _read_range

    version_id = f"artifact-version-{result.source_sha256}"
    if receipt.ranges != tuple(_read_range(item, version_id) for item in returned):
        raise ReadQueryError("Delivered object ranges differ from the read receipt")
    returned_ids = {item.object_id for item in returned}
    expected_unread = tuple(
        _read_range(item, version_id, unread=True)
        for item in observations
        if item.object_id not in returned_ids
    )
    if receipt.unread_ranges != expected_unread:
        raise ReadQueryError("Unread receipt ranges differ from the undelivered source objects")
