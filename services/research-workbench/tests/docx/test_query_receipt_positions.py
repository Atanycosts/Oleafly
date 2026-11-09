"""A query receipt must carry the source byte bounds of the objects it returns.

The reader records where each paragraph sits in its part, and the receipt is what a client
actually receives. This module pins the join between the two: a delivered range names the same
bytes the observation named, and a range that is not the whole located object reports no bounds
rather than borrowing its parent's.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx import DocxReadResult, read_docx
from research_file_workbench.docx.query import ReadQuery, query_docx
from research_file_workbench.docx.read_receipt import ReadReceipt

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx"


@pytest.fixture
def regions_document() -> DocxReadResult:
    return read_docx(FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx")


def _receipt(result: DocxReadResult, query: ReadQuery) -> ReadReceipt:
    response: JsonObject = query_docx(
        result,
        query,
        task_id="query-test-task",
        actor_id="query-test-operator",
        client_id="query-test-client",
    )
    return ReadReceipt.from_json(response["read_receipt"])


def test_delivered_text_block_ranges_name_the_recorded_bytes(
    regions_document: DocxReadResult,
) -> None:
    receipt = _receipt(regions_document, ReadQuery(object_type="text_block", page_size=50))
    by_locator = {block.node_locator: block for block in regions_document.text_blocks}
    delivered = [item for item in receipt.ranges if item.range_type == "text_block"]
    assert delivered, "the query returned no text block to check"

    for item in delivered:
        block = by_locator[item.locator]
        assert block.byte_start is not None, item.locator
        assert (item.start, item.end) == (block.byte_start, block.byte_end), item.locator


def test_a_sub_object_range_borrows_no_offsets(regions_document: DocxReadResult) -> None:
    """A field carries a locator inside its paragraph, so the paragraph's bounds are not its own."""
    receipt = _receipt(regions_document, ReadQuery(object_type="field", page_size=50))
    delivered = [item for item in receipt.ranges if item.range_type == "field"]
    assert delivered, "the fixture has no field to check"
    for item in delivered:
        assert item.locator.endswith("]"), item.locator
        assert (item.start, item.end) == (None, None), item.locator


def test_an_unread_range_reports_no_offsets(regions_document: DocxReadResult) -> None:
    """Nothing was returned for these objects, so the receipt cannot name bytes for them."""
    receipt = _receipt(regions_document, ReadQuery(object_type="text_block", page_size=1))
    assert receipt.unread_ranges
    for item in receipt.unread_ranges:
        assert (item.start, item.end) == (None, None), item.locator
