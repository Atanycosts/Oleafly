"""Receipt-range conversion and final-report assembly for the S1 pipeline."""

from __future__ import annotations

from pathlib import Path

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.docx.pipeline_report_metadata import (
    artifact_paths,
    run_status_and_unresolved_items,
    source_metadata,
    stage_status,
)
from research_file_workbench.docx.pipeline_report_ranges import read_ranges_from_report
from research_file_workbench.docx.pipeline_snapshot import SourceSnapshot
from research_file_workbench.docx.read_receipt import ReadReceipt

__all__ = ["build_run_report", "read_ranges_from_report"]


def build_run_report(
    *,
    snapshot: SourceSnapshot,
    author_path: Path,
    package_report: JsonObject,
    read_receipt: ReadReceipt,
    result: DocxReadResult,
    output_directory: Path,
    render_report: JsonObject | None,
    page_report: JsonObject | None,
    page_index: JsonObject | None,
    workspace_comparison: JsonObject,
    source_hash_after: str,
    actor_id: str,
    client_id: str,
) -> JsonObject:
    """Assemble status, stage states, and paths for the persisted run report."""
    status, unresolved_items = run_status_and_unresolved_items(
        snapshot=snapshot,
        package_report=package_report,
        result=result,
        page_report=page_report,
        page_index=page_index,
        render_report=render_report,
        workspace_comparison=workspace_comparison,
        source_hash_after=source_hash_after,
    )
    paths = artifact_paths(
        output_directory,
        page_report=page_report,
        render_report=render_report,
        page_index=page_index,
    )
    return {
        "version": "s1-readonly-pipeline-1.1.0",
        "run_id": snapshot.run_id,
        "status": status,
        "stage_status": stage_status(package_report, page_report, page_index),
        "created_at": utc_now_iso(),
        "source": source_metadata(snapshot, author_path, source_hash_after),
        "structure_report": paths["structure_report"],
        "read_receipt": paths["read_receipt"],
        "read_record_id": read_receipt.read_record_id,
        "page_mapping_report": paths["page_mapping_report"],
        "render_record": paths["render_record"],
        "page_evidence_index": paths["page_evidence_index"],
        "workspace_comparison": paths["workspace_comparison"],
        "actual_read_ranges": package_report["actual_read_ranges"],
        "unresolved_items": sorted(set(unresolved_items)),
        "author_workspace_unchanged": workspace_comparison.get("unchanged") is True,
        "read_only": True,
        "actor_id": actor_id,
        "client_id": client_id,
    }
