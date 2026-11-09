"""Reviewed physical-page selection for the DOCX query boundary."""

from __future__ import annotations

from typing import TYPE_CHECKING, NoReturn, cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.page_mapping import PAGE_MAPPING_VERSION

if TYPE_CHECKING:
    from research_file_workbench.docx.query_index import Observation as _Observation


def _error(message: str) -> NoReturn:
    from research_file_workbench.docx.query import ReadQueryError

    raise ReadQueryError(message)


def _validate_header(source_sha256: str, mapping: JsonObject, page_number: int) -> list[object]:
    if mapping.get("version") != PAGE_MAPPING_VERSION:
        _error("Page mapping method version does not match the supported version")
    if mapping.get("source_sha256") != source_sha256:
        _error("Page mapping source does not match the queried DOCX version")
    page_count = mapping.get("page_count")
    if page_count is not None:
        if type(page_count) is not int or page_count < 1:
            _error("Page mapping page_count must be a positive integer")
        if page_number > page_count:
            _error("Requested page is outside the verified page count")
    mappings = mapping.get("mappings")
    if not isinstance(mappings, list):
        _error("Page mapping must contain a mappings array")
    return [page_count, mappings]


def _candidate_index(
    observations: list[_Observation],
) -> dict[tuple[str, str, int | None], list[str]]:
    indexed: dict[tuple[str, str, int | None], list[str]] = {}
    for item in observations:
        occurrence = (
            cast(int, item.content["occurrence_index"]) if item.object_type == "field" else None
        )
        identity = (cast(str, item.content["node_locator"]), item.object_type, occurrence)
        indexed.setdefault(identity, []).append(item.object_id)
    return indexed


def _entry_shape(entry: JsonObject) -> tuple[str, str | None, list[str], list[int], list[object]]:
    status = entry.get("mapping_status")
    independent = entry.get("independent_mapping_status")
    if not isinstance(status, str) or status not in {"reviewed", "ambiguous", "unmapped"}:
        _error("Page mapping entry has an invalid mapping status")
    if independent is not None and not isinstance(independent, str):
        _error("Independent mapping status must be a string or null")
    locators = entry.get("reader_candidate_locators")
    pages = entry.get("page_numbers")
    if not isinstance(locators, list) or not all(isinstance(value, str) for value in locators):
        _error("Page mapping candidate locators must be strings")
    if not isinstance(pages, list) or not all(type(value) is int and value > 0 for value in pages):
        _error("Page mapping page numbers must be positive integers")
    descriptors = entry.get("reader_candidates")
    if not isinstance(descriptors, list):
        _error("Page mapping requires typed reader candidates; rebuild it")
    return status, independent, locators, pages, descriptors


def _resolve_candidates(
    descriptors: list[object],
    by_identity: dict[tuple[str, str, int | None], list[str]],
    locators: list[str],
) -> list[str]:
    from research_file_workbench.docx.query import OBJECT_TYPES

    descriptor_locators: list[str] = []
    candidates: list[str] = []
    for descriptor in descriptors:
        if not isinstance(descriptor, dict):
            _error("Page mapping reader candidate must be an object")
        value = cast(JsonObject, descriptor)
        node = value.get("node_locator")
        object_type = value.get("object_type")
        occurrence_index = value.get("occurrence_index")
        if not isinstance(node, str) or object_type not in OBJECT_TYPES:
            _error("Page mapping reader candidate has an invalid identity")
        if (
            object_type == "field" and (type(occurrence_index) is not int or occurrence_index < 1)
        ) or (object_type != "field" and occurrence_index is not None):
            _error("Page mapping field occurrence is invalid")
        descriptor_type = object_type
        descriptor_occurrence = cast(int | None, occurrence_index)
        descriptor_locators.append(node)
        candidates.extend(by_identity.get((node, descriptor_type, descriptor_occurrence), []))
    if descriptor_locators != locators:
        _error("Page mapping candidate identities and locators disagree")
    return candidates


def _process_entry(
    entry: JsonObject,
    page_number: int,
    page_count: object,
    by_identity: dict[tuple[str, str, int | None], list[str]],
) -> tuple[set[str], set[str], JsonObject | None]:
    status, independent, locators, pages, descriptors = _entry_shape(entry)
    if page_count is not None and any(value > cast(int, page_count) for value in pages):
        _error("Page mapping entry exceeds the verified page count")
    if len(pages) != len(set(pages)):
        _error("Page mapping page numbers must not repeat")
    candidates = _resolve_candidates(descriptors, by_identity, locators)
    reviewed = (
        status == independent == "reviewed"
        and len(descriptors) == len(candidates) == 1
        and bool(pages)
    )
    if reviewed:
        selected = set(candidates) if page_number in pages else set()
        return selected, set(candidates), None
    if page_number in pages or not pages:
        return (
            set(),
            set(),
            {
                "object_annotation_id": entry.get("object_annotation_id"),
                "mapping_status": status,
                "reason": "Mapping is unreviewed, ambiguous, or has no unique indexed object.",
                "reader_candidate_locators": locators,
            },
        )
    return set(), set(), None


def select_page_objects(
    result_source_sha256: str,
    observations: list[_Observation],
    mapping: JsonObject,
    page_number: int,
) -> tuple[set[str], list[JsonObject]]:
    """Select uniquely reviewed objects for one physical page."""
    page_count, mappings = _validate_header(result_source_sha256, mapping, page_number)
    by_identity = _candidate_index(observations)
    selected_ids: set[str] = set()
    mapped_ids: set[str] = set()
    gaps: list[JsonObject] = []
    for raw in cast(list[object], mappings):
        if not isinstance(raw, dict):
            _error("Page mapping entries must be objects")
        selected, mapped, gap = _process_entry(
            cast(JsonObject, raw), page_number, page_count, by_identity
        )
        selected_ids.update(selected)
        mapped_ids.update(mapped)
        if gap is not None:
            gaps.append(gap)
    gaps.append(
        {
            "reason": (
                "Indexed objects without unique reviewed mappings cannot be assigned to this page."
            ),
            "object_ids": [
                item.object_id for item in observations if item.object_id not in mapped_ids
            ],
        }
    )
    return selected_ids, gaps
