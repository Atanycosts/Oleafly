"""Controlled orchestration for one read-only S1 DOCX run."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from research_file_workbench.common.filesystem import (
    is_within,
    require_no_reparse_points,
    require_owned_output,
    require_within,
)
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import JsonObject, load_json_object, write_json_object
from research_file_workbench.common.pdf import read_pdf_page_count
from research_file_workbench.common.png import inspect_png
from research_file_workbench.common.workspace import (
    WORKSPACE_FINGERPRINT_VERSION,
    build_workspace_fingerprint,
    compare_workspace_fingerprint,
)
from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.docx.page_mapping import join_page_evidence
from research_file_workbench.docx.pipeline_errors import S1PipelineError
from research_file_workbench.docx.pipeline_evidence import (
    build_page_evidence_index,
    validate_page_mapping_report,
    validate_render_record,
)
from research_file_workbench.docx.pipeline_report import (
    build_run_report,
    read_ranges_from_report,
)
from research_file_workbench.docx.pipeline_snapshot import SourceSnapshot, create_source_snapshot
from research_file_workbench.docx.read_receipt import (
    READ_RECEIPT_VERSION,
    ReadRange,
    ReadReceipt,
    build_read_receipt,
    write_read_receipt,
)
from research_file_workbench.docx.reader import read_docx
from research_file_workbench.docx.report import docx_read_result_to_report

PIPELINE_VERSION = "s1-readonly-pipeline-1.1.0"

__all__ = ["PIPELINE_VERSION", "S1PipelineError", "run_s1_readonly"]


@dataclass(frozen=True, slots=True)
class _PreparedRun:
    """Validated intermediate artifacts that are finalized after the author scan."""

    source: Path
    output_directory: Path
    author_workspace_root: Path
    before_workspace: JsonObject
    snapshot: SourceSnapshot
    result: DocxReadResult
    package_report: JsonObject
    read_receipt: ReadReceipt
    render_report: JsonObject | None
    page_index: JsonObject | None
    page_report: JsonObject | None


def run_s1_readonly(
    source: Path,
    *,
    application_root: Path,
    output_directory: Path,
    author_workspace_root: Path,
    document_annotation: Path | None = None,
    page_evidence: Path | None = None,
    render_record: Path | None = None,
    page_image_directory: Path | None = None,
    author_workspace_baseline: Path | None = None,
    actor_id: str = "local-operator",
    client_id: str = "rfw-s1-read",
) -> JsonObject:
    """Run one immutable, read-only S1 DOCX inspection.

    The source is copied into application-owned storage before parsing. Optional page evidence
    is joined only when both independent annotation files are supplied. The function writes only
    below ``output_directory`` and returns the same JSON object written to ``run-report.json``.
    """
    prepared = _prepare_run(
        source=source,
        application_root=application_root,
        output_directory=output_directory,
        author_workspace_root=author_workspace_root,
        document_annotation=document_annotation,
        page_evidence=page_evidence,
        render_record=render_record,
        page_image_directory=page_image_directory,
        author_workspace_baseline=author_workspace_baseline,
        actor_id=actor_id,
        client_id=client_id,
    )
    return _finalize_run(prepared, actor_id=actor_id, client_id=client_id)


def _prepare_run(
    *,
    source: Path,
    application_root: Path,
    output_directory: Path,
    author_workspace_root: Path,
    document_annotation: Path | None,
    page_evidence: Path | None,
    render_record: Path | None,
    page_image_directory: Path | None,
    author_workspace_baseline: Path | None,
    actor_id: str,
    client_id: str,
) -> _PreparedRun:
    """Validate inputs, retain a source snapshot, and write intermediate evidence."""
    _validate_inputs(
        source,
        application_root,
        output_directory,
        author_workspace_root,
        document_annotation,
        page_evidence,
        render_record,
        page_image_directory,
        author_workspace_baseline,
    )
    source = source.resolve()
    application_root = application_root.resolve()
    output_directory = output_directory.resolve()
    author_workspace_root = author_workspace_root.resolve()
    if not source.is_file():
        raise S1PipelineError(f"DOCX source does not exist: {source}")
    if not author_workspace_root.is_dir():
        raise S1PipelineError(f"Author workspace does not exist: {author_workspace_root}")
    require_within(source, author_workspace_root)
    require_owned_output(output_directory, (application_root,), (author_workspace_root,))
    before_workspace = build_workspace_fingerprint(author_workspace_root)
    _validate_workspace_baseline(author_workspace_baseline, before_workspace)
    output_directory.mkdir(parents=True, exist_ok=False)

    snapshot, result, package_report, read_receipt = _read_snapshot(
        source, output_directory, actor_id=actor_id, client_id=client_id
    )
    render_report, page_index, page_report = _prepare_evidence(
        result=result,
        source_hash=snapshot.source_hash,
        application_root=application_root,
        output_directory=output_directory,
        render_record=render_record,
        page_image_directory=page_image_directory,
        document_annotation=document_annotation,
        page_evidence=page_evidence,
    )
    return _PreparedRun(
        source,
        output_directory,
        author_workspace_root,
        before_workspace,
        snapshot,
        result,
        package_report,
        read_receipt,
        render_report,
        page_index,
        page_report,
    )


def _read_snapshot(
    source: Path, output_directory: Path, *, actor_id: str, client_id: str
) -> tuple[SourceSnapshot, DocxReadResult, JsonObject, ReadReceipt]:
    """Retain source bytes, inspect the package, and persist the structural receipt."""
    snapshot = create_source_snapshot(source, output_directory)
    result = read_docx(snapshot.snapshot_path)
    package_report = docx_read_result_to_report(result)
    write_json_object(output_directory / "structure-report.json", package_report)
    reader_version = package_report.get("reader_version")
    if not isinstance(reader_version, str):
        raise S1PipelineError("Structure report has no reader_version")
    read_receipt = build_read_receipt(
        snapshot.run_id,
        _read_ranges_from_report(package_report, snapshot.source_hash),
        actor_id=actor_id,
        client_id=client_id,
        dependencies=(READ_RECEIPT_VERSION, reader_version),
    )
    write_read_receipt(output_directory / "read-receipt.json", read_receipt)
    return snapshot, result, package_report, read_receipt


def _prepare_evidence(
    *,
    result: DocxReadResult,
    source_hash: str,
    application_root: Path,
    output_directory: Path,
    render_record: Path | None,
    page_image_directory: Path | None,
    document_annotation: Path | None,
    page_evidence: Path | None,
) -> tuple[JsonObject | None, JsonObject | None, JsonObject | None]:
    """Validate optional render inputs and persist independent evidence indexes."""
    render_report = _load_render_report(render_record, source_hash, application_root)
    if render_report is not None:
        write_json_object(output_directory / "render-record.json", render_report)
    page_index = _load_page_index(
        page_image_directory, application_root, render_report, output_directory
    )
    page_report = _load_page_report(
        result,
        document_annotation,
        page_evidence,
        render_report,
        page_index,
        output_directory,
    )
    return render_report, page_index, page_report


def _finalize_run(prepared: _PreparedRun, *, actor_id: str, client_id: str) -> JsonObject:
    """Capture post-read integrity and publish the final run report."""
    after_workspace = build_workspace_fingerprint(prepared.author_workspace_root)
    source_hash_after = sha256_file(prepared.source)
    workspace_comparison = compare_workspace_fingerprint(prepared.before_workspace, after_workspace)
    write_json_object(prepared.output_directory / "workspace-comparison.json", workspace_comparison)
    run_report = build_run_report(
        snapshot=prepared.snapshot,
        author_path=prepared.source,
        package_report=prepared.package_report,
        read_receipt=prepared.read_receipt,
        result=prepared.result,
        output_directory=prepared.output_directory,
        render_report=prepared.render_report,
        page_report=prepared.page_report,
        page_index=prepared.page_index,
        workspace_comparison=workspace_comparison,
        source_hash_after=source_hash_after,
        actor_id=actor_id,
        client_id=client_id,
    )
    write_json_object(prepared.output_directory / "run-report.json", run_report)
    return run_report


def _validate_inputs(
    source: Path,
    application_root: Path,
    output_directory: Path,
    author_workspace_root: Path,
    document_annotation: Path | None,
    page_evidence: Path | None,
    render_record: Path | None,
    page_image_directory: Path | None,
    author_workspace_baseline: Path | None,
) -> None:
    for path in (source, application_root, output_directory, author_workspace_root):
        require_no_reparse_points(path)
    if is_within(application_root, author_workspace_root):
        raise S1PipelineError("Application storage must be outside the author workspace")
    if (document_annotation is None) != (page_evidence is None):
        raise S1PipelineError(
            "document_annotation and page_evidence must be supplied together for page mapping"
        )
    for optional_input in (
        document_annotation,
        page_evidence,
        render_record,
        page_image_directory,
        author_workspace_baseline,
    ):
        if optional_input is not None:
            require_no_reparse_points(optional_input)


def _validate_workspace_baseline(
    author_workspace_baseline: Path | None, before_workspace: JsonObject
) -> None:
    if author_workspace_baseline is None:
        return
    baseline = load_json_object(author_workspace_baseline)
    if baseline.get("report_version") != WORKSPACE_FINGERPRINT_VERSION:
        raise S1PipelineError(
            "Workspace baseline lacks current protection evidence; capture a new baseline"
        )
    if compare_workspace_fingerprint(baseline, before_workspace)["unchanged"] is not True:
        raise S1PipelineError("Author workspace differs from the supplied baseline")


def _load_render_report(
    render_record: Path | None, source_hash: str, application_root: Path
) -> JsonObject | None:
    if render_record is None:
        return None
    report = load_json_object(render_record)
    _validate_render_record(report, source_hash, application_root)
    return report


def _load_page_index(
    page_image_directory: Path | None,
    application_root: Path,
    render_report: JsonObject | None,
    output_directory: Path,
) -> JsonObject | None:
    if page_image_directory is None:
        return None
    index = _build_page_evidence_index(
        page_image_directory.resolve(), application_root, render_report
    )
    write_json_object(output_directory / "page-evidence-index.json", index)
    return index


def _load_page_report(
    result: DocxReadResult,
    document_annotation: Path | None,
    page_evidence: Path | None,
    render_report: JsonObject | None,
    page_index: JsonObject | None,
    output_directory: Path,
) -> JsonObject | None:
    if document_annotation is None or page_evidence is None:
        return None
    page_report = join_page_evidence(result, document_annotation, page_evidence).to_json()
    _validate_page_mapping_report(page_report, render_report, page_index)
    write_json_object(output_directory / "page-mapping-report.json", page_report)
    return page_report


# These wrappers preserve the module-local diagnostic hooks used by the boundary tests while the
# implementations live in focused modules. Callers should use ``run_s1_readonly``.
def _validate_render_record(
    render_record: JsonObject, source_hash: str, application_root: Path
) -> None:
    validate_render_record(
        render_record,
        source_hash,
        application_root,
        hash_file=sha256_file,
        page_count_reader=read_pdf_page_count,
    )


def _read_ranges_from_report(report: JsonObject, source_hash: str) -> tuple[ReadRange, ...]:
    return read_ranges_from_report(report, source_hash)


def _validate_page_mapping_report(
    page_report: JsonObject,
    render_report: JsonObject | None,
    page_index: JsonObject | None,
) -> None:
    validate_page_mapping_report(page_report, render_report, page_index)


def _build_page_evidence_index(
    page_directory: Path,
    application_root: Path,
    render_record: JsonObject | None,
) -> JsonObject:
    return build_page_evidence_index(
        page_directory,
        application_root,
        render_record,
        inspect_png_bytes=inspect_png,
        hash_file=sha256_file,
    )
