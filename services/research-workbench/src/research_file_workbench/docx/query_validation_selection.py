"""Selection reconstruction and item checks for DOCX query delivery."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.docx.query_index import Observation, index_observations
from research_file_workbench.docx.report import docx_read_result_to_report

if TYPE_CHECKING:
    from research_file_workbench.docx.query import ReadQuery


@dataclass(frozen=True, slots=True)
class DeliverySelection:
    """Source observations and the reviewed subset expected by one response."""

    query: ReadQuery
    report: JsonObject
    observations: list[Observation]
    selected: list[Observation]
    coverage_gaps: list[JsonObject]


def build_delivery_selection(
    result: DocxReadResult,
    response: JsonObject,
    scope: JsonObject,
    page_size: int,
    page_mapping: JsonObject | None,
) -> DeliverySelection:
    """Recreate source observations and the selected object subset."""
    from research_file_workbench.docx.query import ReadQuery, ReadQueryError

    report = docx_read_result_to_report(result)
    observations = index_observations(result, report)
    if response.get("indexed_object_count") != len(observations):
        raise ReadQueryError("Delivered object count differs from the source index")
    query = ReadQuery(
        region=cast(str | None, scope["region"]),
        object_type=cast(str | None, scope["object_type"]),
        object_id=cast(str | None, scope["object_id"]),
        page_number=cast(int | None, scope["page_number"]),
        page_size=page_size,
    )
    selected = [
        item
        for item in observations
        if (query.region is None or item.region == query.region)
        and (query.object_type is None or item.object_type == query.object_type)
        and (query.object_id is None or item.object_id == query.object_id)
    ]
    coverage_gaps: list[JsonObject] = []
    if query.page_number is not None:
        if page_mapping is None:
            raise ReadQueryError("Delivered page content has no verified mapping")
        from research_file_workbench.docx.query_selection import select_page_objects

        page_ids, coverage_gaps = select_page_objects(
            result.source_sha256, observations, page_mapping, query.page_number
        )
        selected = [item for item in selected if item.object_id in page_ids]
    if query.object_id is not None and not selected:
        raise ReadQueryError("Delivered object ID does not match the selected source observations")
    return DeliverySelection(query, report, observations, selected, coverage_gaps)


def validate_selection_metadata(
    result: DocxReadResult, response: JsonObject, delivery: DeliverySelection
) -> None:
    """Validate metadata and coverage claims against the reconstructed selection."""
    from research_file_workbench.docx.query import ReadQueryError
    from research_file_workbench.docx.query_validation import build_query_metadata

    expected_metadata = build_query_metadata(
        result, delivery.report, delivery.coverage_gaps, delivery.query.page_number
    )
    for field, expected in expected_metadata.items():
        if response.get(field) != expected:
            raise ReadQueryError(f"Delivered {field} differs from the source query metadata")


def slice_selection(
    selected: list[Observation], page_number: int, page_size: int
) -> tuple[int, list[Observation], bool]:
    """Return the expected page slice and continuation state."""
    from research_file_workbench.docx.query import ReadQueryError

    offset = (page_number - 1) * page_size
    if offset and offset >= len(selected):
        raise ReadQueryError("Delivered pagination starts outside the selected objects")
    returned = selected[offset : offset + page_size]
    return offset, returned, offset + len(returned) < len(selected)


def validate_returned_items(response: JsonObject, returned: list[Observation]) -> None:
    """Validate that response items are exactly the selected source objects."""
    from research_file_workbench.docx.query import ReadQueryError

    expected_items = [{**item.metadata(), "content": item.content} for item in returned]
    if response.get("items") != expected_items:
        raise ReadQueryError("Delivered objects or their contents differ from the selected source")
