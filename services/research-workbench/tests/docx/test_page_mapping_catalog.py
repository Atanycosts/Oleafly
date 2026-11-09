import json
from pathlib import Path

from research_file_workbench.docx import join_page_evidence, read_docx

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx"
ANNOTATION_ROOT = PROJECT_ROOT / "annotations" / "s1"

_FIXTURES = (
    ("s1-regions-fields", "normal/s1-regions-fields/s1-regions-fields.docx", "reviewed"),
    ("s1-sections-layout", "normal/s1-sections-layout/s1-sections-layout.docx", "reviewed"),
    ("s1-figures-tables", "normal/s1-figures-tables/s1-figures-tables.docx", "reviewed"),
    ("s1-embedded-objects", "normal/s1-embedded-objects/s1-embedded-objects.docx", "reviewed"),
    (
        "s1-broken-relationships",
        "faults/s1-broken-relationships/s1-broken-relationships.docx",
        "reviewed",
    ),
    ("s1-missing-font", "environment/s1-missing-font/s1-missing-font.docx", "reviewed"),
    (
        "s1-pagination-ambiguity",
        "normal/s1-pagination-ambiguity/s1-pagination-ambiguity.docx",
        "partial",
    ),
    (
        "s1-native-complex-objects",
        "native/s1-native-complex-objects/s1-native-complex-objects.docx",
        "reviewed",
    ),
)


def test_all_reviewed_fixture_page_evidence_joins_without_fabricated_coordinates() -> None:
    for sample_id, relative_source, expected_status in _FIXTURES:
        source = FIXTURE_ROOT / relative_source
        annotation = json.loads(
            (ANNOTATION_ROOT / sample_id / "document-annotation.json").read_text(encoding="utf-8")
        )
        evidence = json.loads(
            (ANNOTATION_ROOT / sample_id / "page-evidence.json").read_text(encoding="utf-8")
        )

        report = join_page_evidence(read_docx(source), annotation, evidence).to_json()

        assert report["status"] == expected_status
        assert all("reader_candidate_locators" in mapping for mapping in report["mappings"])
        if expected_status == "partial":
            assert any(mapping["mapping_status"] == "ambiguous" for mapping in report["mappings"])
