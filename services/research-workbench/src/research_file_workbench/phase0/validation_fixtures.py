"""Validation of Phase 0 fixture catalogs and independent evidence."""

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from research_file_workbench.common.filesystem import require_within
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import JsonObject, load_json_object
from research_file_workbench.phase0.contract_checks import (
    keyed_records,
    object_array,
    string_array,
    string_value,
)
from research_file_workbench.phase0.evidence_checks import validate_fixture_evidence
from research_file_workbench.phase0.models import ContractValueError


@dataclass
class _FixtureFindings:
    failures: list[str] = field(default_factory=list)
    unreviewed: list[str] = field(default_factory=list)
    incomplete_pages: list[str] = field(default_factory=list)
    covered_cases: set[str] = field(default_factory=set)


def _object_array(document: JsonObject | None, key: str) -> list[JsonObject]:
    if document is None:
        raise ContractValueError(f"Missing document for {key}")
    return object_array(document, key)


def validate_fixture_contracts(
    contract_directory: Path,
    documents: dict[str, JsonObject],
    fixture_groups: list[JsonObject],
    *,
    load_json: Callable[[Path], JsonObject] = load_json_object,
) -> tuple[list[JsonObject], list[JsonObject], list[JsonObject]]:
    """Validate fixture sources, annotations, render records, and required cases."""
    project_root = contract_directory.parents[1]
    fixtures, render_catalog, render_records = _load_fixture_catalogs(
        project_root, documents, load_json
    )
    findings = _FixtureFindings()
    for fixture in fixtures:
        _validate_fixture(
            project_root, fixture, render_catalog, render_records, load_json, findings
        )
    return _fixture_results(fixtures, fixture_groups, findings)


def _load_fixture_catalogs(
    project_root: Path,
    documents: dict[str, JsonObject],
    load_json: Callable[[Path], JsonObject],
) -> tuple[list[JsonObject], JsonObject, dict[str, JsonObject]]:
    render_catalog_path = project_root / "reports" / "phase0" / "fixture-render-catalog.json"
    render_catalog: JsonObject = {}
    render_records: dict[str, JsonObject] = {}
    if render_catalog_path.is_file():
        render_catalog = load_json(render_catalog_path)
        render_records = keyed_records(object_array(render_catalog, "fixtures"), "sample_id")
        profiles = keyed_records(
            object_array(documents["render-environments.json"], "profiles"), "profile_id"
        )
        if render_catalog.get("render_profile_id") not in profiles:
            raise ContractValueError("Unknown fixture render profile")
    fixtures = [
        *_object_array(documents.get("docx-fixture-catalog.json"), "fixtures"),
        *_object_array(documents.get("native-docx-fixture-catalog.json"), "fixtures"),
    ]
    keyed_records(fixtures, "sample_id")
    if set(render_records) != {item["sample_id"] for item in fixtures}:
        raise ContractValueError("Fixture render catalog membership mismatch")
    return fixtures, render_catalog, render_records


def _validate_fixture(
    project_root: Path,
    fixture: JsonObject,
    render_catalog: JsonObject,
    render_records: dict[str, JsonObject],
    load_json: Callable[[Path], JsonObject],
    findings: _FixtureFindings,
) -> None:
    sample_id = fixture.get("sample_id")
    relative_path = fixture.get("relative_path")
    expected_hash = fixture.get("sha256")
    if not isinstance(sample_id, str) or not isinstance(relative_path, str):
        findings.failures.append("fixture-missing-id-or-path")
        return
    evidence = _load_fixture_inputs(
        project_root, sample_id, relative_path, expected_hash, load_json, findings
    )
    if evidence is None:
        return
    source_path, annotation, page_evidence = evidence
    _validate_annotation_identity(sample_id, expected_hash, annotation, page_evidence, findings)
    render_record = render_records.get(sample_id)
    if render_record is None:
        findings.failures.append(f"{sample_id}:missing-render-record")
    else:
        validate_fixture_evidence(
            project_root,
            source_path,
            fixture,
            annotation,
            page_evidence,
            render_record,
            string_value(render_catalog, "render_profile_id"),
        )
        _validate_object_reviews(sample_id, annotation, page_evidence, findings)
        _validate_page_reviews(sample_id, page_evidence, render_record, findings)
    for case in object_array(fixture, "cases"):
        case_id = case.get("case_id")
        if isinstance(case_id, str) and case.get("implementation_status") not in {
            "unsupported",
            "not_generated",
        }:
            findings.covered_cases.add(case_id)


def _load_fixture_inputs(
    project_root: Path,
    sample_id: str,
    relative_path: str,
    expected_hash: object,
    load_json: Callable[[Path], JsonObject],
    findings: _FixtureFindings,
) -> tuple[Path, JsonObject, JsonObject] | None:
    fixture_root = project_root / "tests" / "fixtures" / "docx"
    annotation_root = project_root / "annotations" / "s1"
    source_path = fixture_root / relative_path
    require_within(source_path, fixture_root)
    if not source_path.is_file():
        findings.failures.append(f"{sample_id}:missing-source")
        return None
    if not isinstance(expected_hash, str) or sha256_file(source_path) != expected_hash:
        findings.failures.append(f"{sample_id}:source-hash-mismatch")
    annotation_path = annotation_root / sample_id / "document-annotation.json"
    page_path = annotation_root / sample_id / "page-evidence.json"
    require_within(annotation_path, annotation_root)
    if not annotation_path.is_file() or not page_path.is_file():
        findings.failures.append(f"{sample_id}:missing-annotation")
        return None
    return source_path, load_json(annotation_path), load_json(page_path)


def _validate_annotation_identity(
    sample_id: str,
    expected_hash: object,
    annotation: JsonObject,
    page_evidence: JsonObject,
    findings: _FixtureFindings,
) -> None:
    if annotation.get("artifact_sha256") != expected_hash:
        findings.failures.append(f"{sample_id}:annotation-hash-mismatch")
    if page_evidence.get("source_artifact_sha256") != expected_hash:
        findings.failures.append(f"{sample_id}:page-source-hash-mismatch")
    if annotation.get("review_status") != "reviewed":
        findings.unreviewed.append(f"{sample_id}:document")
    if page_evidence.get("review_status") != "reviewed":
        findings.unreviewed.append(f"{sample_id}:pages")


def _validate_object_reviews(
    sample_id: str, annotation: JsonObject, page_evidence: JsonObject, findings: _FixtureFindings
) -> None:
    for item in object_array(annotation, "objects"):
        if item.get("review_status") not in {"reviewed", "unsupported"}:
            findings.unreviewed.append(f"{sample_id}:{item.get('annotation_id')}")
    for item in object_array(page_evidence, "mappings"):
        if item.get("mapping_status") != "reviewed":
            findings.unreviewed.append(f"{sample_id}:{item.get('annotation_id')}")


def _validate_page_reviews(
    sample_id: str, page_evidence: JsonObject, render_record: JsonObject, findings: _FixtureFindings
) -> None:
    mappings = page_evidence.get("mappings")
    page_reviewed = page_evidence.get("review_status") == "reviewed"
    if page_evidence.get("pdf_sha256") is None and not page_reviewed:
        findings.incomplete_pages.append(f"{sample_id}:missing-pdf-hash")
    elif page_evidence.get("pdf_sha256") != render_record.get("pdf_sha256"):
        findings.failures.append(f"{sample_id}:page-pdf-hash-mismatch")
    if (not isinstance(mappings, list) or not mappings) and not page_reviewed:
        findings.incomplete_pages.append(f"{sample_id}:missing-page-mappings")
    elif not isinstance(mappings, list) or not mappings:
        findings.failures.append(f"{sample_id}:reviewed-without-page-mappings")
    else:
        _validate_page_numbers(sample_id, mappings, render_record.get("page_count"), findings)


def _validate_page_numbers(
    sample_id: str, mappings: list[object], page_count: object, findings: _FixtureFindings
) -> None:
    for mapping in mappings:
        if not isinstance(mapping, dict):
            findings.failures.append(f"{sample_id}:invalid-page-mapping")
            continue
        page_numbers = mapping.get("page_numbers")
        if not isinstance(page_numbers, list) or not page_numbers:
            findings.failures.append(f"{sample_id}:empty-page-numbers")
        elif not isinstance(page_count, int) or any(
            not isinstance(page_number, int) or page_number < 1 or page_number > page_count
            for page_number in page_numbers
        ):
            findings.failures.append(f"{sample_id}:page-number-out-of-range")


def _fixture_results(
    fixtures: list[JsonObject], fixture_groups: list[JsonObject], findings: _FixtureFindings
) -> tuple[list[JsonObject], list[JsonObject], list[JsonObject]]:
    required_cases = {
        case_id
        for group in fixture_groups
        for case_id in string_array(group, "required_cases")
        if case_id not in {"renderer_unavailable", "render_failure", "bypass_attempt"}
    }
    missing_cases = sorted(required_cases - findings.covered_cases)
    contract_checks = [
        {
            "check_id": "fixture-catalog-sources-and-annotations-valid",
            "passed": bool(fixtures) and not findings.failures,
            "detail": findings.failures,
        },
        {
            "check_id": "fixture-required-cases-covered",
            "passed": not missing_cases,
            "detail": missing_cases,
        },
    ]
    completion_checks: list[JsonObject] = [
        {
            "check_id": "fixture-annotations-independently-reviewed",
            "passed": not findings.unreviewed,
            "detail": findings.unreviewed,
        }
    ]
    blockers: list[JsonObject] = []
    for blocker_id, details in (
        ("fixture-contract-errors", findings.failures),
        ("fixture-required-cases-missing", missing_cases),
        ("fixture-annotations-not-reviewed", findings.unreviewed),
        ("fixture-page-evidence-incomplete", findings.incomplete_pages),
    ):
        if details:
            blockers.append({"blocker_id": blocker_id, "detail": details})
    return contract_checks, completion_checks, blockers
