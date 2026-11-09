"""Catalog and annotation writers for generated Phase 0 DOCX fixtures."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from markers import FixtureIdentity

from research_file_workbench.common.filesystem import require_owned_output
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import write_json_object


@dataclass(frozen=True)
class AnnotationObject:
    """One expected fixture object awaiting independent human review."""

    annotation_id: str
    region: str
    kind: str
    locator: str
    expected_support: str
    review_status: str = "pending_review"
    expected_relations: tuple[str, ...] = ()
    limitations: tuple[str, ...] = ()


@dataclass(frozen=True)
class FixtureCase:
    """State the generation and review status of one fixture-matrix case."""

    case_id: str
    implementation_status: str
    expected_support: str
    limitations: tuple[str, ...] = ()


@dataclass(frozen=True)
class FixtureRecord:
    """Describe one generated DOCX fixture and its contract coverage."""

    identity: FixtureIdentity
    artifact_id: str
    group_id: str
    cases: tuple[FixtureCase, ...]
    objects: tuple[AnnotationObject, ...]
    generation_status: str = "generated"
    limitations: tuple[str, ...] = ()


def write_annotation(
    annotation_root: Path,
    record: FixtureRecord,
    artifact_sha256: str,
) -> None:
    """Write a pending independent-annotation draft for one fixture."""
    sample_directory = annotation_root / record.identity.sample_id
    document_path = sample_directory / "document-annotation.json"
    evidence_path = sample_directory / "page-evidence.json"
    for output in (document_path, evidence_path):
        require_owned_output(output, (annotation_root,))
    sample_directory.mkdir(parents=True, exist_ok=True)
    document_annotation = {
        "annotation_version": "1.0.0",
        "sample_id": record.identity.sample_id,
        "artifact_id": record.artifact_id,
        "artifact_sha256": artifact_sha256,
        "annotator": "pending-independent-review",
        "review_status": "pending_review",
        "objects": [
            {
                "annotation_id": item.annotation_id,
                "region": item.region,
                "kind": item.kind,
                "locator": item.locator,
                "expected_support": item.expected_support,
                "review_status": item.review_status,
                "expected_relations": list(item.expected_relations),
                "limitations": list(item.limitations),
            }
            for item in record.objects
        ],
    }
    page_evidence = {
        "annotation_version": "1.0.0",
        "sample_id": record.identity.sample_id,
        "source_artifact_sha256": artifact_sha256,
        "render_profile_id": "wps-writer-12.1.0.28505",
        "pdf_sha256": None,
        "review_status": "pending_review",
        "mappings": [],
        "limitations": [
            "Page evidence must be added after an independent pinned WPS render.",
            "No page number is inferred from package structure or fixture-generation order.",
        ],
    }
    write_json_object(document_path, document_annotation)
    write_json_object(evidence_path, page_evidence)


def write_catalog(
    catalog_path: Path,
    fixture_root: Path,
    records: tuple[FixtureRecord, ...],
) -> None:
    """Write the single machine-readable catalog for generated and non-DOCX scenarios."""
    require_owned_output(catalog_path, (catalog_path.parent,))
    fixtures = []
    for record in records:
        fixture_path = fixture_root / record.identity.relative_path
        fixtures.append(
            {
                "sample_id": record.identity.sample_id,
                "artifact_id": record.artifact_id,
                "relative_path": record.identity.relative_path,
                "sha256": sha256_file(fixture_path),
                "group_id": record.group_id,
                "cases": [
                    {
                        "case_id": item.case_id,
                        "implementation_status": item.implementation_status,
                        "expected_support": item.expected_support,
                        "limitations": list(item.limitations),
                    }
                    for item in record.cases
                ],
                "generation_status": record.generation_status,
                "annotation_status": "pending_review",
                "annotation_relative_path": (
                    f"annotations/s1/{record.identity.sample_id}/document-annotation.json"
                ),
                "limitations": list(record.limitations),
            }
        )
    catalog = {
        "contract_version": "1.0.0",
        "generator": "tools/fixture_building/build_docx_fixtures.py",
        "fixtures": fixtures,
        "non_docx_scenarios": [
            {
                "scenario_id": "renderer-unavailable",
                "source_sample_id": "s1-regions-fields",
                "execution_status": "not_executed",
                "expected_result": "explicit_renderer_unavailable",
            },
            {
                "scenario_id": "render-failure",
                "source_sample_id": "s1-regions-fields",
                "execution_status": "not_executed",
                "expected_result": "explicit_render_failure",
            },
            {
                "scenario_id": "bypass-attempt",
                "source_sample_id": "s1-regions-fields",
                "execution_status": "not_executed",
                "expected_result": "access_denied_without_content_disclosure",
            },
        ],
    }
    write_json_object(catalog_path, catalog)
