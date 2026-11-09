"""Join independent page evidence to a read-only DOCX result.

Page evidence is authored outside the reader.  This module only performs a
bounded, deterministic join: it checks the source version, finds reader
observations that can support an annotation locator, and preserves the
independent page numbers.  It never invents coordinates or upgrades an
ambiguous observation to a reviewed mapping.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

from research_file_workbench.common.json_io import JsonObject, load_json_object
from research_file_workbench.docx.mapping_candidates import MappingCandidate, find_candidates
from research_file_workbench.docx.models import (
    DocxReadResult,
)

PAGE_MAPPING_VERSION = "s1-page-mapping-1.1.0"

MappingStatus = Literal["reviewed", "ambiguous", "unmapped"]


class PageMappingError(ValueError):
    """Raised when independent page evidence cannot be safely joined."""


@dataclass(frozen=True)
class PageMappingResult:
    """Stable JSON-compatible result of one source-to-page evidence join."""

    report: JsonObject

    @property
    def status(self) -> str:
        value = self.report.get("status")
        return value if isinstance(value, str) else "partial"

    def to_json(self) -> JsonObject:
        """Return the immutable report payload."""

        return self.report


def join_page_evidence(
    result: DocxReadResult,
    document_annotation: JsonObject | Path,
    page_evidence: JsonObject | Path,
) -> PageMappingResult:
    """Join reviewed page evidence to ``result`` using bounded locators.

    ``document_annotation`` and ``page_evidence`` may be loaded JSON objects or
    paths to the external annotation files.  The source SHA-256 in both files
    must equal the immutable hash captured by ``DocxReadResult``.  Mapping
    status is downgraded to ``ambiguous`` or ``unmapped`` whenever the reader
    cannot produce exactly one bounded candidate for the annotated object.
    """

    annotation = _load_input(document_annotation, "document annotation")
    evidence = _load_input(page_evidence, "page evidence")
    _validate_source_hash(result, annotation, evidence)
    if evidence.get("review_status") != "reviewed" or annotation.get("review_status") != "reviewed":
        raise PageMappingError("Page evidence is not independently reviewed")

    annotation_objects = _annotation_objects(annotation)
    raw_mappings = _required_list(evidence, "mappings", "page evidence")
    _validate_mapping_ids(raw_mappings)
    mappings: list[JsonObject] = []
    for raw_mapping in raw_mappings:
        mapping = _mapping_object(raw_mapping)
        object_annotation_id = _required_string(mapping, "object_annotation_id", "mapping")
        annotation_object = annotation_objects.get(object_annotation_id)
        page_numbers = _page_numbers(mapping)
        if annotation_object is None:
            mappings.append(
                _mapping_report(
                    mapping,
                    status="unmapped",
                    candidates=[],
                    page_numbers=page_numbers,
                    limitations=[
                        "Mapping refers to an annotation object that is absent from "
                        "document-annotation.json."
                    ],
                )
            )
            continue

        candidates = find_candidates(result, annotation_object)
        mapping_status = _mapping_status(mapping)
        if (
            len(candidates) == 1
            and mapping_status == "reviewed"
            and annotation_object.get("review_status") == "reviewed"
            and page_numbers
        ):
            status: MappingStatus = "reviewed"
            limitations = _mapping_limitations(mapping)
        elif len(candidates) > 1:
            status = "ambiguous"
            limitations = _mapping_limitations(mapping) + [
                "Multiple reader observations match the bounded annotation locator; "
                "page evidence is not assigned to one source node."
            ]
        else:
            status = "unmapped"
            limitations = _mapping_limitations(mapping) + [
                "No unique reader observation matches the bounded annotation locator; "
                "page evidence is preserved without claiming a source mapping."
            ]
        if mapping_status != "reviewed":
            limitations.append(
                f"Independent page mapping status is {mapping_status}; "
                "it is not promoted to reviewed."
            )
            if status == "reviewed":
                status = "unmapped"
        mappings.append(
            _mapping_report(
                mapping,
                status=status,
                candidates=candidates,
                page_numbers=page_numbers,
                limitations=limitations,
            )
        )

    statuses = [item["mapping_status"] for item in mappings]
    overall_status = (
        "reviewed" if statuses and all(item == "reviewed" for item in statuses) else "partial"
    )
    report: JsonObject = {
        "version": PAGE_MAPPING_VERSION,
        "status": overall_status,
        "source_sha256": result.source_sha256,
        "source_path": result.source_path,
        "pdf_sha256": _optional_string(evidence, "pdf_sha256"),
        "render_profile_id": _optional_string(evidence, "render_profile_id"),
        "sample_id": _optional_string(evidence, "sample_id"),
        "mappings": mappings,
        "limitations": _report_limitations(evidence, mappings),
    }
    return PageMappingResult(report=report)


def _validate_mapping_ids(mappings: list[object]) -> None:
    annotation_ids: set[str] = set()
    object_ids: set[str] = set()
    for raw_mapping in mappings:
        mapping = _mapping_object(raw_mapping)
        annotation_id = mapping.get("annotation_id")
        object_id = mapping.get("object_annotation_id")
        if isinstance(annotation_id, str) and annotation_id in annotation_ids:
            raise PageMappingError(f"Duplicate mapping annotation_id: {annotation_id}")
        if isinstance(object_id, str) and object_id in object_ids:
            raise PageMappingError(f"Duplicate mapping object_annotation_id: {object_id}")
        if isinstance(annotation_id, str):
            annotation_ids.add(annotation_id)
        if isinstance(object_id, str):
            object_ids.add(object_id)


def _load_input(value: JsonObject | Path, label: str) -> JsonObject:
    if isinstance(value, Path):
        return load_json_object(value)
    if not isinstance(value, Mapping):
        raise PageMappingError(f"{label} must be a JSON object or Path")
    return cast(JsonObject, dict(value))


def _validate_source_hash(
    result: DocxReadResult, annotation: JsonObject, evidence: JsonObject
) -> None:
    annotation_hash = _required_string(annotation, "artifact_sha256", "document annotation")
    evidence_hash = _required_string(evidence, "source_artifact_sha256", "page evidence")
    if annotation_hash != result.source_sha256:
        raise PageMappingError(
            "Document annotation source hash does not match the DocxReadResult source hash"
        )
    if evidence_hash != result.source_sha256:
        raise PageMappingError(
            "Page evidence source hash does not match the DocxReadResult source hash"
        )
    if annotation_hash != evidence_hash:
        raise PageMappingError("Document annotation and page evidence source hashes differ")


def _annotation_objects(annotation: JsonObject) -> dict[str, JsonObject]:
    records = _required_list(annotation, "objects", "document annotation")
    objects: dict[str, JsonObject] = {}
    for raw in records:
        item = _mapping_object(raw)
        annotation_id = _required_string(item, "annotation_id", "annotation object")
        if annotation_id in objects:
            raise PageMappingError(f"Duplicate annotation_id: {annotation_id}")
        objects[annotation_id] = item
    return objects


def _required_list(document: JsonObject, key: str, label: str) -> list[object]:
    value = document.get(key)
    if not isinstance(value, list):
        raise PageMappingError(f"{label} field {key!r} must be an array")
    return value


def _mapping_object(value: object) -> JsonObject:
    if not isinstance(value, Mapping):
        raise PageMappingError("Annotation and mapping entries must be JSON objects")
    return cast(JsonObject, dict(value))


def _required_string(document: JsonObject, key: str, label: str) -> str:
    value = document.get(key)
    if not isinstance(value, str) or not value:
        raise PageMappingError(f"{label} field {key!r} must be a non-empty string")
    return value


def _optional_string(document: JsonObject, key: str) -> str | None:
    value = document.get(key)
    return value if isinstance(value, str) else None


def _mapping_status(mapping: JsonObject) -> str:
    value = mapping.get("mapping_status")
    if value not in ("reviewed", "ambiguous", "unmapped", "unreviewed"):
        raise PageMappingError("Mapping status is not supported")
    return value


def _page_numbers(mapping: JsonObject) -> list[int]:
    value = mapping.get("page_numbers", [])
    if not isinstance(value, list):
        raise PageMappingError("Mapping page_numbers must be an array")
    pages: list[int] = []
    for page in value:
        if isinstance(page, bool) or not isinstance(page, int) or page < 1:
            raise PageMappingError("Mapping page_numbers must contain positive integers")
        pages.append(page)
    if len(set(pages)) != len(pages):
        raise PageMappingError("Mapping page_numbers must not contain duplicates")
    return pages


def _mapping_limitations(mapping: JsonObject) -> list[str]:
    value = mapping.get("limitations", [])
    return _unique_strings(value)


def _report_limitations(evidence: JsonObject, mappings: list[JsonObject]) -> list[str]:
    limitations = _unique_strings(evidence.get("limitations", []))
    if any(item.get("mapping_status") == "ambiguous" for item in mappings):
        limitations.append("At least one mapping has multiple bounded reader candidates.")
    if any(item.get("mapping_status") == "unmapped" for item in mappings):
        limitations.append(
            "At least one page mapping has no unique reader candidate or is not "
            "independently reviewed."
        )
    return _unique_strings(limitations)


def _unique_strings(value: object) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise PageMappingError("Limitations must be an array of strings")
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if isinstance(item, str) and item not in seen:
            seen.add(item)
            result.append(item)
    return result


def _mapping_report(
    mapping: JsonObject,
    *,
    status: MappingStatus,
    candidates: list[MappingCandidate],
    page_numbers: list[int],
    limitations: list[str],
) -> JsonObject:
    result: JsonObject = {
        "annotation_id": _optional_string(mapping, "annotation_id"),
        "object_annotation_id": _optional_string(mapping, "object_annotation_id"),
        "mapping_status": status,
        "independent_mapping_status": _mapping_status(mapping),
        "reader_candidate_locators": [candidate.locator for candidate in candidates],
        "reader_candidates": [candidate.to_json() for candidate in candidates],
        "page_numbers": page_numbers,
        "limitations": _unique_strings(limitations),
    }
    evidence = mapping.get("evidence")
    if isinstance(evidence, str):
        result["evidence"] = evidence
    return result
