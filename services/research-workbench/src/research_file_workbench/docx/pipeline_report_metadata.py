"""Build independently testable sections of an S1 pipeline run report."""

from __future__ import annotations

from pathlib import Path

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.docx.pipeline_snapshot import SourceSnapshot
from research_file_workbench.docx.report import COVERAGE_STATUS


def run_status_and_unresolved_items(
    *,
    snapshot: SourceSnapshot,
    package_report: JsonObject,
    result: DocxReadResult,
    page_report: JsonObject | None,
    page_index: JsonObject | None,
    render_report: JsonObject | None,
    workspace_comparison: JsonObject,
    source_hash_after: str,
) -> tuple[str, list[str]]:
    """Determine overall status and retain every unresolved pipeline condition."""
    status = "completed"
    unresolved_items = list(result.issues)
    if result.issues:
        status = "partial"
        unresolved_items.append("reader-issues-present")
    if package_report.get("status") == COVERAGE_STATUS:
        status = "partial"
        unresolved_items.append("structural-coverage-partial")
    if page_report is not None:
        if page_report.get("status") != "reviewed":
            status = "partial"
            unresolved_items.append("page-mapping-partial")
    else:
        status = "partial"
        unresolved_items.append("page-mapping-not-supplied")
    if page_index is None:
        status = "partial"
        unresolved_items.append("page-evidence-index-not-supplied")
    if render_report is None:
        status = "partial"
        unresolved_items.append("render-record-not-supplied")
    if workspace_comparison.get("unchanged") is not True:
        status = "failed"
        unresolved_items.append("author-workspace-changed")
    if source_hash_after != snapshot.source_hash:
        status = "failed"
        unresolved_items.append("source-hash-drift")
    return status, unresolved_items


def stage_status(
    package_report: JsonObject,
    page_report: JsonObject | None,
    page_index: JsonObject | None,
) -> JsonObject:
    """Build the status of each independently supplied pipeline stage."""
    return {
        "structural_read": (
            "completed_with_limitations"
            if package_report.get("status") == COVERAGE_STATUS
            else "completed"
        ),
        "page_mapping": (
            "reviewed"
            if page_report is not None and page_report.get("status") == "reviewed"
            else "partial"
            if page_report is not None
            else "pending_independent_review"
        ),
        "page_evidence": "indexed_unverified" if page_index is not None else "not_supplied",
    }


def source_metadata(
    snapshot: SourceSnapshot, author_path: Path, source_hash_after: str
) -> JsonObject:
    """Build source identity metadata for the retained application snapshot."""
    return {
        "author_path": author_path.as_posix(),
        "author_sha256": snapshot.source_hash,
        "author_sha256_after": source_hash_after,
        "snapshot_path": snapshot.snapshot_path.as_posix(),
        "snapshot_sha256": snapshot.snapshot_hash,
        "version_id": f"artifact-version-{snapshot.source_hash}",
    }


def artifact_paths(
    output_directory: Path,
    *,
    page_report: JsonObject | None,
    render_report: JsonObject | None,
    page_index: JsonObject | None,
) -> JsonObject:
    """Build persisted artifact paths, preserving absent optional evidence as null."""
    return {
        "structure_report": (output_directory / "structure-report.json").as_posix(),
        "read_receipt": (output_directory / "read-receipt.json").as_posix(),
        "page_mapping_report": (
            (output_directory / "page-mapping-report.json").as_posix()
            if page_report is not None
            else None
        ),
        "render_record": (
            (output_directory / "render-record.json").as_posix()
            if render_report is not None
            else None
        ),
        "page_evidence_index": (
            (output_directory / "page-evidence-index.json").as_posix()
            if page_index is not None
            else None
        ),
        "workspace_comparison": (output_directory / "workspace-comparison.json").as_posix(),
    }
