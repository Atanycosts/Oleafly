import json
from pathlib import Path

from research_file_workbench.docx import docx_read_result_to_report, read_docx

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx"


def test_report_is_json_compatible_and_preserves_source_identity() -> None:
    source = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"

    report = docx_read_result_to_report(read_docx(source))

    json.dumps(report, ensure_ascii=False)
    assert report["version"] == "1.0.0"
    assert report["source"]["sha256"] == read_docx(source).source_sha256
    assert report["source"]["read_only"] is True
    assert report["status"] == "partial"


def test_report_serializes_structural_objects_with_explicit_statuses() -> None:
    source = FIXTURE_ROOT / "normal/s1-figures-tables/s1-figures-tables.docx"

    report = docx_read_result_to_report(read_docx(source))

    assert report["parts"]
    assert all("parse_status" in item for item in report["parts"])
    assert all("parse_status" in item for item in report["relationships"])
    assert report["tables"][0]["parse_status"] == "parsed"
    assert report["tables"][0]["rows"][0][0]["parse_status"] == "parsed"
    assert {item["container"] for item in report["images"]} == {"inline", "anchored"}
    assert all(item["limitations"] for item in report["images"])


def test_report_preserves_unsupported_objects_and_issues() -> None:
    source = FIXTURE_ROOT / "native/s1-native-complex-objects/s1-native-complex-objects.docx"

    report = docx_read_result_to_report(read_docx(source))
    objects_by_kind = {item["kind"]: item for item in report["complex_objects"]}

    assert objects_by_kind["chart"]["parse_status"] == "unsupported"
    assert "word/charts/chart1.xml" in objects_by_kind["chart"]["related_parts"]
    assert objects_by_kind["ole"]["available_preview"] == ["word/media/image1.emf"]
    assert report["coverage"]
    assert report["coverage"]["docx-complex-embedded-objects"]["status"] == "partial"


def test_report_declares_actual_read_ranges_and_limitations() -> None:
    source = FIXTURE_ROOT / "faults/s1-broken-relationships/s1-broken-relationships.docx"

    report = docx_read_result_to_report(read_docx(source))
    range_locators = {item["locator"] for item in report["actual_read_ranges"]}

    assert str(source.resolve()).replace("\\", "/") in range_locators
    assert "word/document.xml" in range_locators
    assert report["issues"]
    assert any("unresolved-relationship:" in item for item in report["limitations"])


def test_report_exposes_structured_unsupported_records() -> None:
    source = FIXTURE_ROOT / "normal/s1-embedded-objects/s1-embedded-objects.docx"

    report = docx_read_result_to_report(read_docx(source))

    assert report["unsupported_records"]
    record = next(
        item for item in report["unsupported_records"] if item["kind"] == "unknown_namespace"
    )
    assert record["source_location"] == "customXml/item1.xml"
    assert record["parse_status"] == "unsupported"
