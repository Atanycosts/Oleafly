from __future__ import annotations

import json
from pathlib import Path

import pytest

from research_file_workbench.docx import PageMappingError, join_page_evidence, read_docx

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx"
ANNOTATION_ROOT = PROJECT_ROOT / "annotations" / "s1"


def _load(sample_id: str) -> tuple[object, object, Path]:
    annotation_path = ANNOTATION_ROOT / sample_id / "document-annotation.json"
    evidence_path = ANNOTATION_ROOT / sample_id / "page-evidence.json"
    source = next(FIXTURE_ROOT.rglob(f"{sample_id}.docx"))
    return (
        json.loads(annotation_path.read_text(encoding="utf-8")),
        json.loads(evidence_path.read_text(encoding="utf-8")),
        source,
    )


def test_joiner_preserves_reviewed_mapping_and_page_metadata() -> None:
    annotation, evidence, source = _load("s1-figures-tables")

    report = join_page_evidence(read_docx(source), annotation, evidence).to_json()

    assert report["status"] == "reviewed"
    assert report["pdf_sha256"] == evidence["pdf_sha256"]
    assert report["render_profile_id"] == "wps-writer-12.1.0.28505"
    first = report["mappings"][0]
    assert first["mapping_status"] == "reviewed"
    assert first["reader_candidate_locators"] == ["word/document.xml#drawing[1]"]
    assert first["page_numbers"] == [1]


def test_joiner_keeps_duplicate_text_ambiguous() -> None:
    annotation, evidence, source = _load("s1-pagination-ambiguity")

    report = join_page_evidence(read_docx(source), annotation, evidence).to_json()
    duplicate = next(
        item
        for item in report["mappings"]
        if item["object_annotation_id"] == "rfw-fx-pa-duplicate-text"
    )

    assert report["status"] == "partial"
    assert duplicate["mapping_status"] == "ambiguous"
    assert len(duplicate["reader_candidate_locators"]) == 2
    assert duplicate["page_numbers"] == list(range(1, 15))


def test_joiner_rejects_source_hash_drift() -> None:
    annotation, evidence, source = _load("s1-regions-fields")
    evidence["source_artifact_sha256"] = "0" * 64

    with pytest.raises(PageMappingError, match="source hash"):
        join_page_evidence(read_docx(source), annotation, evidence)


@pytest.mark.parametrize(
    "kind",
    ["nested_field", "zotero_field", "cross_reference", "inline_equation", "external_target"],
)
def test_nonexistent_marker_never_matches_an_object_of_the_same_kind(kind: str) -> None:
    annotation, evidence, source = _load("s1-regions-fields")
    item = next(item for item in annotation["objects"] if item["kind"] == kind)
    item["locator"] = "word/document.xml RFW-NOT-PRESENT-ANYWHERE"
    report = join_page_evidence(read_docx(source), annotation, evidence).to_json()
    mapping = next(
        item_mapping
        for item_mapping in report["mappings"]
        if item_mapping["object_annotation_id"] == item["annotation_id"]
    )
    assert mapping["mapping_status"] == "unmapped"
    assert mapping["reader_candidate_locators"] == []


def test_wrong_paragraph_is_not_ignored_when_an_object_is_unique() -> None:
    annotation, evidence, source = _load("s1-figures-tables")
    annotation["objects"][0]["locator"] = (
        "word/document.xml body paragraph 99; wp:inline wp:docPr id=1"
    )
    report = join_page_evidence(read_docx(source), annotation, evidence).to_json()
    assert report["mappings"][0]["mapping_status"] == "unmapped"


@pytest.mark.parametrize("target", ["annotation", "evidence", "object"])
def test_review_state_cannot_be_inferred_from_mapping_label(target: str) -> None:
    annotation, evidence, source = _load("s1-figures-tables")
    if target == "object":
        annotation["objects"][0]["review_status"] = "pending_review"
        report = join_page_evidence(read_docx(source), annotation, evidence).to_json()
        assert report["mappings"][0]["mapping_status"] == "unmapped"
    else:
        document = annotation if target == "annotation" else evidence
        document.pop("review_status")
        with pytest.raises(PageMappingError, match="independently reviewed"):
            join_page_evidence(read_docx(source), annotation, evidence)


def test_reviewed_mapping_requires_at_least_one_page() -> None:
    annotation, evidence, source = _load("s1-figures-tables")
    evidence["mappings"][0]["page_numbers"] = []
    report = join_page_evidence(read_docx(source), annotation, evidence).to_json()
    assert report["mappings"][0]["mapping_status"] == "unmapped"


@pytest.mark.parametrize(
    "field,value",
    [("page_numbers", [1, 1]), ("limitations", "missing proof"), ("mapping_status", "typo")],
)
def test_malformed_mapping_inputs_are_not_silently_normalized(field: str, value: object) -> None:
    annotation, evidence, source = _load("s1-figures-tables")
    evidence["mappings"][0][field] = value
    with pytest.raises(PageMappingError):
        join_page_evidence(read_docx(source), annotation, evidence)
