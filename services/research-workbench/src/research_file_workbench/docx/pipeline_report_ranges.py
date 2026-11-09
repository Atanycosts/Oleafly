"""Convert structural report ranges into immutable S1 receipt ranges."""

from __future__ import annotations

from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.pipeline_errors import S1PipelineError
from research_file_workbench.docx.read_receipt import (
    READ_RECEIPT_VERSION,
    ParseStatus,
    ReadRange,
)

_PARSE_STATUSES = {"parsed", "partial", "unsupported", "failed", "unverified"}


def read_ranges_from_report(report: JsonObject, source_hash: str) -> tuple[ReadRange, ...]:
    """Convert explicit reader ranges into the immutable receipt range model."""
    raw_ranges = report.get("actual_read_ranges")
    if not isinstance(raw_ranges, list):
        raise S1PipelineError("Structure report has no actual_read_ranges array")
    version_id = f"artifact-version-{source_hash}"
    return tuple(_read_range(raw_range, version_id) for raw_range in raw_ranges)


def _read_range(raw_range: object, version_id: str) -> ReadRange:
    if not isinstance(raw_range, dict):
        raise S1PipelineError("Structure report contains an invalid read range")
    locator = raw_range.get("locator")
    range_type = raw_range.get("range_type")
    if not isinstance(locator, str) or not locator.strip():
        raise S1PipelineError("Structure report contains a read range without a locator")
    if not isinstance(range_type, str) or not range_type.strip():
        raise S1PipelineError("Structure report contains a read range without a range_type")
    parse_status = raw_range.get("parse_status")
    if not isinstance(parse_status, str) or parse_status not in _PARSE_STATUSES:
        raise S1PipelineError("Structure report contains an invalid read-range status")
    start, end = _read_bounds(raw_range)
    limitations = (
        () if parse_status == "parsed" else ("Range was read without complete semantic parsing.",)
    )
    return ReadRange(
        version_id=version_id,
        locator=locator,
        range_type=range_type,
        start=start,
        end=end,
        parse_status=cast(ParseStatus, parse_status),
        limitations=limitations,
        dependencies=(READ_RECEIPT_VERSION,),
    )


def _read_bounds(raw_range: dict[object, object]) -> tuple[int | None, int | None]:
    if "start" not in raw_range and "end" not in raw_range:
        return None, None
    raw_start = raw_range.get("start")
    raw_end = raw_range.get("end")
    if (
        not isinstance(raw_start, int)
        or isinstance(raw_start, bool)
        or not isinstance(raw_end, int)
        or isinstance(raw_end, bool)
        or raw_start < 0
        or raw_end < raw_start
    ):
        raise S1PipelineError("Structure report contains an invalid read-range bound")
    return raw_start, raw_end
