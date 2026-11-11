"""Validate captured rendering bytes and independent annotations before persistence."""

import re
from dataclasses import replace
from datetime import datetime
from typing import cast

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.common.png import PngInspectionError, inspect_png
from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.docx.page_mapping import PAGE_MAPPING_VERSION, join_page_evidence
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.projects.models import ProjectStoreError

BUNDLE_VERSION = "s1-render-bundle-1.2.0"
HISTORICAL_PAGE_BUNDLE_VERSION = "s1-render-bundle-1.1.0"
SUPPORTED_BUNDLE_VERSIONS = frozenset({BUNDLE_VERSION, HISTORICAL_PAGE_BUNDLE_VERSION})
DERIVED_RENDER_REPORT_VERSION = "libreoffice-headless-1.0.0"


def validate_render_bundle(
    *,
    result: DocxReadResult,
    render_record: JsonObject,
    pdf_bytes: bytes,
    pdf_page_count: int,
    page_index: JsonObject,
    page_images: dict[int, bytes],
    document_annotation: JsonObject | None = None,
    page_evidence: JsonObject | None = None,
) -> JsonObject:
    """Validate a captured bundle, preserving partial and independently unreviewed states.

    The caller supplies a physical PDF page count and captures files inside its allowed roots.
    This operation checks captured bytes; it does not execute or re-attest a rendering process.
    """
    if type(pdf_page_count) is not int or pdf_page_count < 1:
        raise ProjectStoreError("Physical PDF page count must be a positive integer")
    pdf_hash = sha256_bytes(pdf_bytes)
    profile = _validate_render_record(render_record, result.source_sha256, pdf_hash, len(pdf_bytes))
    if not pdf_bytes.startswith(b"%PDF-"):
        raise ProjectStoreError("Captured PDF does not begin with a PDF signature")
    pages = _validate_pages(page_index, page_images, pdf_hash, profile, pdf_page_count)
    if (document_annotation is None) != (page_evidence is None):
        raise ProjectStoreError("Document annotation and page evidence must be supplied together")
    mapping: JsonObject | None = None
    mapping_status = "pending_independent_review"
    if document_annotation is not None and page_evidence is not None:
        _validate_annotations(
            document_annotation,
            page_evidence,
            result.source_sha256,
            pdf_hash,
            profile,
            pdf_page_count,
        )
        stable_result = replace(result, source_path=f"artifact-version-{result.source_sha256}")
        try:
            mapping = join_page_evidence(
                stable_result, document_annotation, page_evidence
            ).to_json()
        except (ValueError, TypeError) as exc:
            raise ProjectStoreError(f"Cannot rebuild the independent page mapping: {exc}") from exc
        mapping["page_count"] = pdf_page_count
        mapping["reader_version"] = READER_VERSION
        mapping_status = cast(str, mapping["status"])
    return {
        "version": HISTORICAL_PAGE_BUNDLE_VERSION,
        "source_sha256": result.source_sha256,
        "pdf_sha256": pdf_hash,
        "render_profile_id": profile,
        "page_count": pdf_page_count,
        "reader_version": READER_VERSION,
        "mapping_version": PAGE_MAPPING_VERSION,
        "mapping": mapping,
        "mapping_status": mapping_status,
        "render_record": render_record,
        "page_index": page_index,
        "document_annotation": document_annotation,
        "page_evidence": page_evidence,
        "pages": pages,
        "limitations": [
            "Renderer identity is preserved from a historical record; registration does not "
            "re-attest the rendering process.",
            "Matching image hashes establish captured bytes, not that the images were rasterized "
            "from this PDF or that visual and scientific contents are correct.",
            "Independent reviewer labels record provenance; they do not authenticate a person.",
            "Stored page images do not count as a visual read or establish complete page coverage.",
        ],
    }


def _validate_render_record(record: JsonObject, source: str, pdf_hash: str, size: int) -> str:
    if record.get("report_version") != "1.1.0":
        raise ProjectStoreError("Unsupported historical render-record version")
    if record.get("source_sha256") != source or record.get("render_copy_sha256") != source:
        raise ProjectStoreError("Render record source differs from the selected source version")
    if record.get("source_unchanged") is not True:
        raise ProjectStoreError("Render record did not establish an unchanged source")
    if record.get("renderer_identity_status") != "process_verified":
        raise ProjectStoreError("Render record lacks historical process verification")
    if record.get("output_sha256") != pdf_hash:
        raise ProjectStoreError("Captured PDF hash differs from the render record")
    if type(record.get("output_size")) is not int or record["output_size"] != size:
        raise ProjectStoreError("Captured PDF size differs from the render record")
    for key in (
        "renderer_path",
        "renderer_file_version",
        "export_method",
        "source_path",
        "render_copy_path",
        "output_path",
    ):
        _text(record, key)
    if re.fullmatch(r"[0-9a-f]{64}", _text(record, "renderer_sha256")) is None:
        raise ProjectStoreError("Renderer executable hash is not a SHA-256 digest")
    pid = record.get("renderer_process_id")
    if type(pid) is not int or pid < 1:
        raise ProjectStoreError("Historical renderer process ID must be a positive integer")
    _timestamp(record, "renderer_start_time_utc")
    return _text(record, "render_profile_id")


def _validate_pages(
    index: JsonObject, images: dict[int, bytes], pdf_hash: str, profile: str, count: int
) -> list[JsonObject]:
    if index.get("version") != "s1-page-evidence-index-1.0.0":
        raise ProjectStoreError("Unsupported page-index version")
    if index.get("pdf_sha256") != pdf_hash or index.get("render_profile_id") != profile:
        raise ProjectStoreError("Page index PDF or renderer profile differs")
    if type(index.get("page_count")) is not int or index["page_count"] != count:
        raise ProjectStoreError("Page index count differs from the physical PDF")
    expected = set(range(1, count + 1))
    if any(type(number) is not int for number in images) or set(images) != expected:
        raise ProjectStoreError("Captured page images must cover every physical PDF page")
    pages = _objects(index, "pages")
    seen: set[int] = set()
    result: list[JsonObject] = []
    for page in pages:
        number = page.get("page_number")
        if type(number) is not int or number not in expected or number in seen:
            raise ProjectStoreError("Page index numbers must be unique integers in the PDF range")
        seen.add(number)
        content = images[number]
        digest = sha256_bytes(content)
        if page.get("sha256") != digest:
            raise ProjectStoreError("Captured PNG hash differs from the page index")
        try:
            width, height = inspect_png(content)
        except PngInspectionError as exc:
            raise ProjectStoreError(str(exc)) from exc
        result.append({"page_number": number, "sha256": digest, "width": width, "height": height})
    if seen != expected:
        raise ProjectStoreError("Page index has missing pages")
    return sorted(result, key=lambda item: cast(int, item["page_number"]))


def _validate_annotations(
    annotation: JsonObject,
    evidence: JsonObject,
    source: str,
    pdf_hash: str,
    profile: str,
    count: int,
) -> None:
    for record, reviewer in ((annotation, "annotator"), (evidence, "reviewed_by")):
        if record.get("review_status") != "reviewed":
            raise ProjectStoreError("Independent annotation records must be reviewed")
        _text(record, reviewer)
        _text(record, "review_method")
        _timestamp(record, "reviewed_at")
        if record.get("annotation_version") != "1.0.0":
            raise ProjectStoreError("Unsupported independent annotation version")
    if _text(annotation, "sample_id") != _text(evidence, "sample_id"):
        raise ProjectStoreError("Independent annotation sample identities differ")
    if (
        annotation.get("artifact_sha256") != source
        or evidence.get("source_artifact_sha256") != source
    ):
        raise ProjectStoreError("Independent annotation source hashes differ from the snapshot")
    if evidence.get("pdf_sha256") != pdf_hash or evidence.get("render_profile_id") != profile:
        raise ProjectStoreError("Independent page evidence PDF or profile differs")
    objects: dict[str, JsonObject] = {}
    for item in _objects(annotation, "objects"):
        identity = _text(item, "annotation_id")
        if identity in objects:
            raise ProjectStoreError("Duplicate independent object annotation ID")
        if item.get("review_status") not in (
            "reviewed",
            "unsupported",
            "pending_review",
            "unreviewed",
        ):
            raise ProjectStoreError("Independent object review status is invalid")
        objects[identity] = item
    mapping_ids: set[str] = set()
    mapped_objects: set[str] = set()
    for item in _objects(evidence, "mappings"):
        identity = _text(item, "annotation_id")
        object_id = _text(item, "object_annotation_id")
        if identity in mapping_ids or object_id in mapped_objects:
            raise ProjectStoreError("Duplicate independent mapping identity")
        mapping_ids.add(identity)
        mapped_objects.add(object_id)
        if object_id not in objects:
            raise ProjectStoreError("Mapping references an absent independent object annotation")
        status = item.get("mapping_status")
        if status not in ("reviewed", "ambiguous", "unmapped", "unreviewed"):
            raise ProjectStoreError("Independent mapping status is invalid")
        numbers = item.get("page_numbers")
        if not isinstance(numbers, list) or any(
            type(number) is not int or number < 1 or number > count for number in numbers
        ):
            raise ProjectStoreError("Mapping page numbers must be integers within the PDF")
        if len(numbers) != len(set(numbers)):
            raise ProjectStoreError("Mapping page numbers must not repeat")
        if status == "reviewed" and (
            not numbers or objects[object_id].get("review_status") != "reviewed"
        ):
            raise ProjectStoreError("Reviewed mappings require reviewed objects and nonempty pages")
        _text(item, "evidence")


def _objects(record: JsonObject, key: str) -> list[JsonObject]:
    values = record.get(key)
    if not isinstance(values, list) or any(not isinstance(item, dict) for item in values):
        raise ProjectStoreError(f"{key} must be an array of structured records")
    return cast(list[JsonObject], values)


def _text(record: JsonObject, key: str) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ProjectStoreError(f"Evidence field {key} must be a nonblank string")
    return value


def _timestamp(record: JsonObject, key: str) -> None:
    try:
        value = datetime.fromisoformat(_text(record, key))
    except ValueError as exc:
        raise ProjectStoreError(f"Evidence field {key} is not an ISO timestamp") from exc
    if value.tzinfo is None or value.utcoffset() is None:
        raise ProjectStoreError(f"Evidence timestamp {key} must include its timezone")
