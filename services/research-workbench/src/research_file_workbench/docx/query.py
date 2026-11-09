"""Bounded queries over the existing DOCX observations and reviewed page mappings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import (
    DocxReadResult,
)
from research_file_workbench.docx.query_index import Observation as _Observation
from research_file_workbench.docx.query_index import index_observations as _index
from research_file_workbench.docx.query_selection import select_page_objects
from research_file_workbench.docx.query_validation import (
    build_query_metadata,
    cursor_offset,
    encode_cursor,
    query_binding,
)
from research_file_workbench.docx.query_validation import (
    validate_query_delivery as _validate_query_delivery,
)
from research_file_workbench.docx.read_receipt import (
    ParseStatus,
    ReadCaller,
    ReadPagination,
    ReadRange,
    ReadReceipt,
    build_read_receipt,
)
from research_file_workbench.docx.report import (
    COVERAGE_STATUS,
    READER_VERSION,
    docx_read_result_to_report,
)

QUERY_VERSION = "s1-read-query-1.7.0"

# Continuation state of the requested selection after this response.  It is derived from the
# same computation as ``pagination.has_more``, so it says only whether another page exists --
# never how much of the selection a single response holds, and never anything about document
# coverage, which stays on the separate ``status`` (coverage) axis.  A response reached with a
# cursor can be the last page of a selection it only partly contains; every selected object it
# did not return stays in the receipt's unread ranges.
CONTINUATION_EXHAUSTED = "continuation_exhausted"
CONTINUATION_AVAILABLE = "continuation_available"
OBJECT_TYPES = (
    "text_block",
    "table",
    "image",
    "math",
    "field",
    "section",
    "break",
    "complex_object",
    "reference",
)
REGIONS = ("body", "header", "footer", "footnote", "endnote", "textbox")
_COLLECTIONS = (
    "text_blocks",
    "tables",
    "images",
    "math_objects",
    "fields",
    "sections",
    "breaks",
    "complex_objects",
    "references",
)
_LIMITATIONS = (
    "Results follow object type and reader order, not rendered reading order.",
    "Only returned object observations are read; package coverage and semantics remain partial.",
    "Image and preview references do not mean their visual contents were read.",
    "Part-level regions do not establish table or textbox containment.",
)


class ReadQueryError(ValueError):
    """Raised when a selection, cursor, or page mapping cannot be used as declared."""


@dataclass(frozen=True, slots=True)
class ReadQuery:
    """Select complete observations; page size limits objects, never object text."""

    region: str | None = None
    object_type: str | None = None
    object_id: str | None = None
    page_number: int | None = None
    page_size: int = 20
    cursor: str | None = None

    def __post_init__(self) -> None:
        if self.region is not None and self.region not in REGIONS:
            raise ReadQueryError(f"Unsupported region: {self.region}")
        if self.object_type is not None and self.object_type not in OBJECT_TYPES:
            raise ReadQueryError(f"Unsupported object type: {self.object_type}")
        for name, value in (("object_id", self.object_id), ("cursor", self.cursor)):
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise ReadQueryError(f"{name} must be a nonblank string")
        if type(self.page_size) is not int or self.page_size < 1:
            raise ReadQueryError("page_size must be a positive integer")
        if self.page_number is not None and (
            type(self.page_number) is not int or self.page_number < 1
        ):
            raise ReadQueryError("page_number must be a positive integer")


def catalog_docx(result: DocxReadResult) -> JsonObject:
    """Return object metadata without content or a receipt claiming it was read."""
    report = docx_read_result_to_report(result)
    observations = _index(result, report)
    return {
        "query_version": QUERY_VERSION,
        "reader_version": READER_VERSION,
        "status": "catalog_only",
        "source": _source(result),
        "object_types": list(OBJECT_TYPES),
        "regions": list(REGIONS),
        "items": [item.metadata() for item in observations],
        "reader_issues": list(result.issues),
        "unsupported_records": report["unsupported_records"],
        "limitations": [
            "This directory does not count as reading its listed objects.",
            *_LIMITATIONS,
        ],
    }


def object_observations(result: DocxReadResult) -> tuple[JsonObject, ...]:
    """Return source observations for persistent evidence, without issuing a read receipt."""
    report = docx_read_result_to_report(result)
    return tuple({**item.metadata(), "content": item.content} for item in _index(result, report))


def query_docx(
    result: DocxReadResult,
    query: ReadQuery,
    *,
    task_id: str,
    actor_id: str,
    client_id: str,
    caller: ReadCaller | None = None,
    page_mapping: JsonObject | None = None,
    baseline_id: str | None = None,
) -> JsonObject:
    """Return one page and its exact read receipt, rejecting stale or invalid selections.

    Page selection requires externally verified mapping evidence. This function validates
    its source and shape; the caller remains responsible for checking referenced files.
    """
    report = docx_read_result_to_report(result)
    observations = _index(result, report)
    if query.object_id is not None and not any(
        item.object_id == query.object_id for item in observations
    ):
        raise ReadQueryError("Object ID is unknown for this source and reader version")
    selected = [
        item
        for item in observations
        if (query.region is None or item.region == query.region)
        and (query.object_type is None or item.object_type == query.object_type)
        and (query.object_id is None or item.object_id == query.object_id)
    ]
    gaps: list[JsonObject] = []
    if query.page_number is not None:
        if page_mapping is None:
            raise ReadQueryError("Page selection requires reviewed page-mapping evidence")
        page_ids, gaps = select_page_objects(
            result.source_sha256, observations, page_mapping, query.page_number
        )
        selected = [item for item in selected if item.object_id in page_ids]
    if query.object_id is not None and not selected:
        raise ReadQueryError(
            "Object ID does not match the requested region, type, or reviewed page"
        )
    scope: JsonObject = {
        "region": query.region,
        "object_type": query.object_type,
        "object_id": query.object_id,
        "page_number": query.page_number,
    }
    return _build_query_response(
        result,
        query,
        report,
        observations,
        selected,
        gaps,
        scope,
        task_id,
        actor_id,
        client_id,
        caller,
        baseline_id,
        page_mapping,
    )


def _page_delivery(
    result: DocxReadResult,
    query: ReadQuery,
    selected: list[_Observation],
    observations: list[_Observation],
    task_id: str,
    actor_id: str,
    client_id: str,
    caller: ReadCaller | None,
    baseline_id: str | None,
    page_mapping: JsonObject | None,
) -> tuple[list[_Observation], ReadPagination, ReadReceipt]:
    binding = query_binding(
        result,
        {
            "region": query.region,
            "object_type": query.object_type,
            "object_id": query.object_id,
            "page_number": query.page_number,
        },
        query.page_size,
        baseline_id,
        page_mapping,
    )
    offset = cursor_offset(query.cursor, binding, query.page_size, len(selected))
    returned = selected[offset : offset + query.page_size]
    has_more = offset + len(returned) < len(selected)
    next_cursor = encode_cursor(binding, offset + len(returned)) if has_more else None
    pagination = ReadPagination(
        offset // query.page_size + 1, query.page_size, has_more, next_cursor, len(selected)
    )
    dependencies = [READER_VERSION, QUERY_VERSION, binding]
    if query.page_number is not None and page_mapping is not None:
        dependencies.extend(
            str(page_mapping[key])
            for key in ("render_bundle_id", "pdf_sha256", "render_profile_id", "version")
            if page_mapping.get(key) is not None
        )
    returned_ids = {item.object_id for item in returned}
    version_id = f"artifact-version-{result.source_sha256}"
    receipt = build_read_receipt(
        task_id,
        [_read_range(item, version_id) for item in returned],
        actor_id=actor_id,
        client_id=client_id,
        truncation=bool(offset or has_more),
        unread_ranges=[
            _read_range(item, version_id, unread=True)
            for item in observations
            if item.object_id not in returned_ids
        ],
        pagination=pagination,
        method_version=QUERY_VERSION,
        dependencies=dependencies,
        caller=caller,
    )
    return returned, pagination, receipt


def _build_query_response(
    result: DocxReadResult,
    query: ReadQuery,
    report: JsonObject,
    observations: list[_Observation],
    selected: list[_Observation],
    gaps: list[JsonObject],
    scope: JsonObject,
    task_id: str,
    actor_id: str,
    client_id: str,
    caller: ReadCaller | None,
    baseline_id: str | None,
    page_mapping: JsonObject | None,
) -> JsonObject:
    returned, pagination, receipt = _page_delivery(
        result,
        query,
        selected,
        observations,
        task_id,
        actor_id,
        client_id,
        caller,
        baseline_id,
        page_mapping,
    )
    has_more = pagination.has_more
    return {
        "query_version": QUERY_VERSION,
        "reader_version": READER_VERSION,
        "status": COVERAGE_STATUS,
        "selection_delivery": CONTINUATION_AVAILABLE if has_more else CONTINUATION_EXHAUSTED,
        "source": _source(result),
        "query_scope": scope,
        "indexed_object_count": len(observations),
        "items": [{**item.metadata(), "content": item.content} for item in returned],
        "pagination": pagination.to_json(),
        "read_receipt": receipt.to_json(),
        **build_query_metadata(result, report, gaps, query.page_number),
    }


def _byte_bounds(item: _Observation) -> tuple[int | None, int | None]:
    """Return the source byte bounds of a range, when that range is the whole located object.

    The recorded offsets describe the paragraph element. A field carries a sub-locator inside its
    paragraph, so the paragraph's offsets would point at the wrong bytes for it; such a range
    reports no bounds rather than a misleading pair.
    """
    if item.range_locator != item.content.get("node_locator"):
        return None, None
    raw_start = item.content.get("byte_start")
    raw_end = item.content.get("byte_end")
    if raw_start is None and raw_end is None:
        return None, None
    if (
        not isinstance(raw_start, int)
        or isinstance(raw_start, bool)
        or not isinstance(raw_end, int)
        or isinstance(raw_end, bool)
        or raw_start < 0
        or raw_end < raw_start
    ):
        raise ReadQueryError("Observation carries an invalid byte bound")
    return raw_start, raw_end


def _read_range(item: _Observation, version_id: str, *, unread: bool = False) -> ReadRange:
    status = cast(ParseStatus, item.content["parse_status"])
    limitations = tuple(cast(list[str], item.content.get("limitations", [])))
    if unread:
        status = "unverified"
        limitations = ("Object content was not returned by this response.",)
    elif status != "parsed" and not limitations:
        limitations = ("The reader has not completely parsed this object.",)
    # An unread range records that nothing was returned, so it must not name bytes either: an
    # offset would point a client at content this response deliberately withheld.
    start, end = (None, None) if unread else _byte_bounds(item)
    return ReadRange(
        version_id,
        item.range_locator,
        item.object_type,
        start=start,
        end=end,
        parse_status=status,
        limitations=limitations,
        dependencies=(READER_VERSION, QUERY_VERSION),
    )


def _source(result: DocxReadResult) -> JsonObject:
    return {
        "sha256": result.source_sha256,
        "version_id": f"artifact-version-{result.source_sha256}",
    }


def validate_query_delivery(
    result: DocxReadResult,
    response: JsonObject,
    receipt: ReadReceipt,
    *,
    page_mapping: JsonObject | None = None,
    baseline_id: str | None = None,
) -> None:
    """Validate a persisted response against the existing source observations."""
    _validate_query_delivery(
        result,
        response,
        receipt,
        page_mapping=page_mapping,
        baseline_id=baseline_id,
    )
