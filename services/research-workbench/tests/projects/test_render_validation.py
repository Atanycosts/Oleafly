from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import JsonObject, load_json_object
from research_file_workbench.docx import DocxReadResult, read_docx
from research_file_workbench.projects.models import ProjectStoreError
from research_file_workbench.projects.render_validation import (
    BUNDLE_VERSION,
    validate_render_bundle,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx" / "normal"
RENDER_ROOT = PROJECT_ROOT / "reports" / "phase0" / "fixtures"
ANNOTATION_ROOT = PROJECT_ROOT / "annotations" / "s1"


@dataclass
class RenderFixture:
    result: DocxReadResult
    render_record: JsonObject
    pdf_bytes: bytes
    page_count: int
    page_index: JsonObject
    page_images: dict[int, bytes]
    annotation: JsonObject
    page_evidence: JsonObject


def _fixture(sample_id: str, page_count: int) -> RenderFixture:
    """Use frozen fixture bytes with a synthetic process record; no WPS process is attested."""
    source = FIXTURE_ROOT / sample_id / f"{sample_id}.docx"
    pdf_path = RENDER_ROOT / sample_id / f"{sample_id}.pdf"
    result = read_docx(source)
    pdf_bytes = pdf_path.read_bytes()
    images: dict[int, bytes] = {}
    pages: list[JsonObject] = []
    for path in (pdf_path.parent / "pages-150dpi").glob("page-*.png"):
        page_number = int(path.stem.removeprefix("page-"))
        payload = path.read_bytes()
        images[page_number] = payload
        pages.append(
            {
                "page_number": page_number,
                "path": path.resolve().as_posix(),
                "sha256": sha256_bytes(payload),
                "parse_status": "unverified",
                "limitations": ["Fixture page image is not a new independent review."],
            }
        )
    pages.sort(key=lambda page: cast(int, page["page_number"]))
    profile = "wps-writer-12.1.0.28505"
    record: JsonObject = {
        "report_version": "1.1.0",
        "source_path": source.resolve().as_posix(),
        "source_sha256": result.source_sha256,
        "render_copy_path": "C:/synthetic-fixture/render-copy.docx",
        "render_copy_sha256": result.source_sha256,
        "output_path": pdf_path.resolve().as_posix(),
        "output_sha256": sha256_bytes(pdf_bytes),
        "output_size": len(pdf_bytes),
        "render_profile_id": profile,
        "renderer_path": "C:/synthetic-fixture/wps.exe",
        "renderer_sha256": "a" * 64,
        "renderer_file_version": "12.1.0.28505",
        "renderer_process_id": 1234,
        "renderer_start_time_utc": "2026-09-24T00:00:00Z",
        "renderer_identity_status": "process_verified",
        "source_unchanged": True,
        "export_method": "Synthetic test metadata; no WPS process is launched or attested.",
    }
    index: JsonObject = {
        "version": "s1-page-evidence-index-1.0.0",
        "status": "unverified",
        "render_profile_id": profile,
        "pdf_sha256": sha256_bytes(pdf_bytes),
        "page_count": page_count,
        "pages": pages,
    }
    return RenderFixture(
        result=result,
        render_record=record,
        pdf_bytes=pdf_bytes,
        page_count=page_count,
        page_index=index,
        page_images=images,
        annotation=load_json_object(ANNOTATION_ROOT / sample_id / "document-annotation.json"),
        page_evidence=load_json_object(ANNOTATION_ROOT / sample_id / "page-evidence.json"),
    )


@pytest.fixture
def figures_bundle() -> RenderFixture:
    return _fixture("s1-figures-tables", 3)


def _validate(bundle: RenderFixture, *, reviewed: bool = True) -> JsonObject:
    return validate_render_bundle(
        result=bundle.result,
        render_record=bundle.render_record,
        pdf_bytes=bundle.pdf_bytes,
        pdf_page_count=bundle.page_count,
        page_index=bundle.page_index,
        page_images=bundle.page_images,
        document_annotation=bundle.annotation if reviewed else None,
        page_evidence=bundle.page_evidence if reviewed else None,
    )


def _pages(bundle: RenderFixture) -> list[JsonObject]:
    return cast(list[JsonObject], bundle.page_index["pages"])


def _mappings(bundle: RenderFixture) -> list[JsonObject]:
    return cast(list[JsonObject], bundle.page_evidence["mappings"])


def test_png_header_without_image_chunks_is_rejected(figures_bundle: RenderFixture) -> None:
    figures_bundle.page_images[1] = figures_bundle.page_images[1][:33]
    _pages(figures_bundle)[0]["sha256"] = sha256_bytes(figures_bundle.page_images[1])
    with pytest.raises(ProjectStoreError, match="image data"):
        _validate(figures_bundle)


def test_reviewed_fixture_bundle_preserves_bound_metadata_without_mutating_inputs(
    figures_bundle: RenderFixture,
) -> None:
    original_record = deepcopy(figures_bundle.render_record)
    original_index = deepcopy(figures_bundle.page_index)
    original_annotation = deepcopy(figures_bundle.annotation)
    original_evidence = deepcopy(figures_bundle.page_evidence)

    bundle = _validate(figures_bundle)

    assert bundle["version"] == BUNDLE_VERSION
    assert bundle["source_sha256"] == figures_bundle.result.source_sha256
    assert bundle["pdf_sha256"] == sha256_bytes(figures_bundle.pdf_bytes)
    assert bundle["page_count"] == 3
    mapping = cast(JsonObject, bundle["mapping"])
    assert mapping["status"] == "reviewed"
    assert mapping["page_count"] == 3
    assert mapping["pdf_sha256"] == sha256_bytes(figures_bundle.pdf_bytes)
    assert figures_bundle.render_record == original_record
    assert figures_bundle.page_index == original_index
    assert figures_bundle.annotation == original_annotation
    assert figures_bundle.page_evidence == original_evidence


def test_unannotated_bundle_remains_pending_without_fabricated_page_mapping(
    figures_bundle: RenderFixture,
) -> None:
    bundle = _validate(figures_bundle, reviewed=False)

    assert bundle["version"] == BUNDLE_VERSION
    assert bundle["source_sha256"] == figures_bundle.result.source_sha256
    assert bundle["page_count"] == 3
    assert bundle["mapping"] is None
    assert bundle["mapping_status"] == "pending_independent_review"


def test_duplicate_text_mapping_remains_ambiguous_despite_reviewed_documents() -> None:
    fixture = _fixture("s1-pagination-ambiguity", 14)

    bundle = _validate(fixture)

    mapping = cast(JsonObject, bundle["mapping"])
    duplicate = next(
        item
        for item in cast(list[JsonObject], mapping["mappings"])
        if item["object_annotation_id"] == "rfw-fx-pa-duplicate-text"
    )
    assert mapping["status"] == "partial"
    assert duplicate["mapping_status"] == "ambiguous"
    assert duplicate["independent_mapping_status"] == "reviewed"
    assert len(cast(list[str], duplicate["reader_candidate_locators"])) == 2
    assert duplicate["page_numbers"] == list(range(1, 15))
    assert duplicate["limitations"]


@pytest.mark.parametrize("missing", ["annotation", "page_evidence"])
def test_independent_annotation_and_page_evidence_must_be_supplied_together(
    figures_bundle: RenderFixture, missing: str
) -> None:
    with pytest.raises(ProjectStoreError):
        validate_render_bundle(
            result=figures_bundle.result,
            render_record=figures_bundle.render_record,
            pdf_bytes=figures_bundle.pdf_bytes,
            pdf_page_count=figures_bundle.page_count,
            page_index=figures_bundle.page_index,
            page_images=figures_bundle.page_images,
            document_annotation=None if missing == "annotation" else figures_bundle.annotation,
            page_evidence=None if missing == "page_evidence" else figures_bundle.page_evidence,
        )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("source_sha256", "0" * 64),
        ("render_copy_sha256", "0" * 64),
        ("source_unchanged", False),
        ("source_unchanged", 1),
        ("report_version", "1.0.0"),
        ("output_sha256", "0" * 64),
        ("output_size", 1),
        ("output_size", True),
        ("render_profile_id", "another-render-profile"),
        ("renderer_identity_status", "unverified"),
        ("renderer_path", ""),
        ("renderer_sha256", "invalid-hash"),
        ("renderer_file_version", ""),
        ("renderer_process_id", 0),
        ("renderer_process_id", True),
        ("renderer_start_time_utc", "2026-09-24T00:00:00"),
        ("renderer_start_time_utc", "not-a-timestamp"),
    ],
)
def test_render_record_mismatch_or_unverified_process_is_rejected(
    figures_bundle: RenderFixture, field: str, value: object
) -> None:
    figures_bundle.render_record[field] = value

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)


@pytest.mark.parametrize("document", ["annotation", "page_evidence"])
def test_unreviewed_independent_document_is_rejected(
    figures_bundle: RenderFixture, document: str
) -> None:
    getattr(figures_bundle, document)["review_status"] = "pending_independent_review"

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)


def test_reviewed_mapping_cannot_promote_an_unreviewed_annotation_object(
    figures_bundle: RenderFixture,
) -> None:
    cast(list[JsonObject], figures_bundle.annotation["objects"])[0]["review_status"] = "unreviewed"

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)


@pytest.mark.parametrize("mapping_status", ["unreviewed", "unmapped", "ambiguous"])
def test_individual_unreviewed_mapping_is_preserved_without_promotion(
    figures_bundle: RenderFixture, mapping_status: str
) -> None:
    _mappings(figures_bundle)[0]["mapping_status"] = mapping_status
    cast(list[JsonObject], figures_bundle.annotation["objects"])[0]["review_status"] = "unreviewed"

    bundle = _validate(figures_bundle)

    mapping = cast(JsonObject, bundle["mapping"])
    preserved = next(
        item
        for item in cast(list[JsonObject], mapping["mappings"])
        if item["object_annotation_id"] == "rfw-fx-ft-inline-image-001"
    )
    assert mapping["status"] == "partial"
    assert preserved["mapping_status"] != "reviewed"
    assert preserved["independent_mapping_status"] == mapping_status
    assert preserved["limitations"]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("version", "s1-page-evidence-index-unknown"),
        ("pdf_sha256", "0" * 64),
        ("render_profile_id", "another-render-profile"),
        ("page_count", 4),
        ("page_count", True),
    ],
)
def test_page_index_requires_same_pdf_profile_and_page_count(
    figures_bundle: RenderFixture, field: str, value: object
) -> None:
    figures_bundle.page_index[field] = value

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)


@pytest.mark.parametrize("page_count", [0, -1, True, 2, 4, "3"])
def test_physical_page_count_must_be_positive_and_match_index(
    figures_bundle: RenderFixture, page_count: object
) -> None:
    figures_bundle.page_count = cast(int, page_count)

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)


@pytest.mark.parametrize("page_number", [0, 4, True, "1", 2])
def test_page_index_rejects_noncanonical_or_duplicate_page_numbers(
    figures_bundle: RenderFixture, page_number: object
) -> None:
    _pages(figures_bundle)[0]["page_number"] = page_number

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)


def test_page_image_bytes_must_match_index_hash(figures_bundle: RenderFixture) -> None:
    figures_bundle.page_images[1] += b"changed-content"

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)


def test_pdf_bytes_must_match_render_hash_and_size(figures_bundle: RenderFixture) -> None:
    figures_bundle.pdf_bytes += b"changed-pdf"

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)


@pytest.mark.parametrize("mutation", ["missing", "extra", "bool-key"])
def test_page_images_exactly_cover_indexed_integer_pages(
    figures_bundle: RenderFixture, mutation: str
) -> None:
    if mutation == "missing":
        del figures_bundle.page_images[1]
    elif mutation == "extra":
        figures_bundle.page_images[4] = figures_bundle.page_images[1]
    else:
        payload = figures_bundle.page_images.pop(1)
        figures_bundle.page_images[True] = payload

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)


@pytest.mark.parametrize(
    "mutation", ["signature", "short", "ihdr-type", "ihdr-length", "zero-width"]
)
def test_matching_hash_does_not_make_invalid_png_a_page_image(
    figures_bundle: RenderFixture, mutation: str
) -> None:
    payload = bytearray(figures_bundle.page_images[1])
    if mutation == "signature":
        payload[0] = 0
    elif mutation == "short":
        payload = payload[:24]
    elif mutation == "ihdr-type":
        payload[12:16] = b"IDAT"
    elif mutation == "ihdr-length":
        payload[8:12] = (12).to_bytes(4, "big")
    else:
        payload[16:20] = (0).to_bytes(4, "big")
    figures_bundle.page_images[1] = bytes(payload)
    _pages(figures_bundle)[0]["sha256"] = sha256_bytes(payload)

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)


@pytest.mark.parametrize(
    ("document", "field", "value"),
    [
        ("annotation", "artifact_sha256", "0" * 64),
        ("page_evidence", "source_artifact_sha256", "0" * 64),
        ("page_evidence", "pdf_sha256", "0" * 64),
        ("page_evidence", "render_profile_id", "another-render-profile"),
    ],
)
def test_independent_evidence_must_bind_same_source_pdf_and_profile(
    figures_bundle: RenderFixture, document: str, field: str, value: object
) -> None:
    getattr(figures_bundle, document)[field] = value

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)


@pytest.mark.parametrize("page_numbers", [[], [0], [4], [True], [1, 1], ["1"]])
def test_mapping_pages_must_identify_real_unique_integer_pages(
    figures_bundle: RenderFixture, page_numbers: list[object]
) -> None:
    _mappings(figures_bundle)[0]["page_numbers"] = page_numbers

    with pytest.raises(ProjectStoreError):
        _validate(figures_bundle)
