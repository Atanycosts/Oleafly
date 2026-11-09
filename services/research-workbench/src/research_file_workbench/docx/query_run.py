"""Query an existing application-owned S1 snapshot and persist the exact response."""

from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast

from research_file_workbench.common.filesystem import (
    is_within,
    require_no_reparse_points,
    require_owned_output,
    require_within,
)
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import JsonObject, load_json_object, write_json_object
from research_file_workbench.common.pdf import read_pdf_page_count
from research_file_workbench.common.workspace import WORKSPACE_FINGERPRINT_VERSION
from research_file_workbench.docx.models import (
    DocxReadResult,
)
from research_file_workbench.docx.pipeline import PIPELINE_VERSION
from research_file_workbench.docx.query import ReadQuery, ReadQueryError, catalog_docx, query_docx
from research_file_workbench.docx.read_receipt import ReadReceipt, write_read_receipt
from research_file_workbench.docx.reader import read_docx
from research_file_workbench.docx.report import READER_VERSION


@dataclass(frozen=True)
class QueryRun:
    """Verified local snapshot and its originating task; no author file is reopened."""

    run_id: str
    directory: Path
    snapshot_path: Path
    source_sha256: str
    result: DocxReadResult
    report: JsonObject


def load_query_run(
    run_directory: Path, *, application_root: Path, author_workspace_root: Path
) -> QueryRun:
    """Load a completed or partial read-only run, refusing changed or out-of-scope snapshots."""
    require_no_reparse_points(run_directory)
    require_within(run_directory, application_root)
    if is_within(application_root, author_workspace_root) or is_within(
        run_directory, author_workspace_root
    ):
        raise ReadQueryError("Application inputs must be outside the author workspace")
    directory = run_directory.resolve()
    report = load_json_object(_input_path(directory / "run-report.json", directory))
    if report.get("version") != PIPELINE_VERSION:
        raise ReadQueryError("Unsupported run-report version; create a supported S1 run")
    if report.get("status") not in ("completed", "partial"):
        raise ReadQueryError("Only completed or partial S1 runs can be queried")
    if report.get("read_only") is not True or report.get("author_workspace_unchanged") is not True:
        raise ReadQueryError("The S1 run did not establish an unchanged author workspace")
    comparison = load_json_object(
        _input_path(Path(_text(report, "workspace_comparison")), directory)
    )
    if comparison.get("report_version") != WORKSPACE_FINGERPRINT_VERSION:
        raise ReadQueryError(
            "Workspace protection evidence is incompatible; create a current S1 run"
        )
    if (
        comparison.get("protection_status") != "compatible"
        or comparison.get("protection_unchanged") is not True
        or _text(comparison, "before_protection_sha256")
        != _text(comparison, "after_protection_sha256")
    ):
        raise ReadQueryError("The recorded workspace protection attributes did not match")
    if comparison.get("unchanged") is not True or comparison.get("same_root") is not True:
        raise ReadQueryError("The recorded workspace comparison did not pass")
    for key in ("before_root", "after_root"):
        if Path(_text(comparison, key)).resolve() != author_workspace_root.resolve():
            raise ReadQueryError("Author workspace root differs from the recorded S1 run")
    if _text(comparison, "before_manifest_sha256") != _text(comparison, "after_manifest_sha256"):
        raise ReadQueryError("The recorded workspace fingerprints disagree")
    source = _object(report.get("source"), "source")
    require_within(Path(_text(source, "author_path")), author_workspace_root)
    source_hash = _text(source, "snapshot_sha256")
    if (
        source_hash != _text(source, "author_sha256")
        or source_hash != _text(source, "author_sha256_after")
        or _text(source, "version_id") != f"artifact-version-{source_hash}"
    ):
        raise ReadQueryError("Run source versions disagree; do not reuse this run")
    snapshot = _input_path(Path(_text(source, "snapshot_path")), directory / "snapshot")
    _check_hash(snapshot, source_hash, "Snapshot")
    result = read_docx(snapshot)
    if result.source_sha256 != source_hash:
        raise ReadQueryError("Snapshot changed during parsing")
    _check_hash(snapshot, source_hash, "Snapshot")
    return QueryRun(_text(report, "run_id"), directory, snapshot, source_hash, result, report)


def query_run(
    run_directory: Path,
    query: ReadQuery,
    *,
    application_root: Path,
    author_workspace_root: Path,
    output_directory: Path,
    actor_id: str = "local-operator",
    client_id: str = "rfw-s1-query",
) -> JsonObject:
    """Save returned content and its receipt together in a new application-owned directory.

    Output paths are validated before parsing; all query and evidence checks finish before
    creating the output directory. A failed query never produces a successful read receipt.
    Actor and client labels describe a local operator; this function is not authentication.
    """
    require_no_reparse_points(output_directory)
    require_owned_output(output_directory, (application_root,), (author_workspace_root,))
    if is_within(output_directory, run_directory) or is_within(run_directory, output_directory):
        raise ReadQueryError("Query output must be separate from the source run directory")
    run = load_query_run(
        run_directory,
        application_root=application_root,
        author_workspace_root=author_workspace_root,
    )
    mapping = _load_page_mapping(run, application_root) if query.page_number is not None else None
    response = query_docx(
        run.result,
        query,
        task_id=run.run_id,
        actor_id=actor_id,
        client_id=client_id,
        page_mapping=mapping,
    )
    receipt = ReadReceipt.from_json(response["read_receipt"])
    _check_hash(run.snapshot_path, run.source_sha256, "Snapshot")
    require_no_reparse_points(output_directory)
    response["delivery"] = {
        "kind": "application_owned_response_file",
        "response_path": (output_directory.resolve() / "response.json").as_posix(),
        "receipt_path": (output_directory.resolve() / "read-receipt.json").as_posix(),
        "limitations": [
            "The receipt describes this response file, not a model's understanding or visual "
            "inspection. Actor and client labels are supplied by the local operator."
        ],
    }
    output_directory.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".s1-query-", dir=output_directory.parent) as temporary:
        staging = Path(temporary)
        write_json_object(staging / "response.json", response)
        write_read_receipt(staging / "read-receipt.json", receipt)
        require_no_reparse_points(output_directory)
        require_owned_output(output_directory, (application_root,), (author_workspace_root,))
        # Both records are complete before the Windows directory rename publishes the delivery.
        staging.rename(output_directory)
    return response


def catalog_run(
    run_directory: Path, *, application_root: Path, author_workspace_root: Path
) -> JsonObject:
    """Return discovery metadata without writing a receipt or marking content as read."""
    run = load_query_run(
        run_directory,
        application_root=application_root,
        author_workspace_root=author_workspace_root,
    )
    return catalog_docx(run.result)


def _load_page_mapping(run: QueryRun, application_root: Path) -> JsonObject:
    if run.report.get("page_mapping_report") is None:
        raise ReadQueryError("Page queries require independent page mapping; review it first")
    mapping = load_json_object(
        _input_path(Path(_text(run.report, "page_mapping_report")), run.directory)
    )
    structure = load_json_object(
        _input_path(Path(_text(run.report, "structure_report")), run.directory)
    )
    if structure.get("reader_version") != READER_VERSION:
        raise ReadQueryError("Page mapping was built with another reader; rebuild the mapping")
    structure_source = _object(structure.get("source"), "structure source")
    if structure_source.get("sha256") != run.source_sha256:
        raise ReadQueryError("Page mapping structure report belongs to another snapshot")
    render = load_json_object(_input_path(Path(_text(run.report, "render_record")), run.directory))
    if (
        mapping.get("source_sha256") != run.source_sha256
        or render.get("source_sha256") != run.source_sha256
    ):
        raise ReadQueryError("Page mapping or render source hash differs from the snapshot")
    if render.get("renderer_identity_status") != "process_verified":
        raise ReadQueryError("Page queries require a process-verified render record")
    pdf_hash = _text(render, "output_sha256")
    profile_id = _text(render, "render_profile_id")
    if mapping.get("pdf_sha256") != pdf_hash or mapping.get("render_profile_id") != profile_id:
        raise ReadQueryError("Page mapping does not match the render PDF and profile")
    pdf = _input_path(Path(_text(render, "output_path")), application_root)
    _check_hash(pdf, pdf_hash, "PDF")
    page_count = read_pdf_page_count(pdf)
    _check_hash(pdf, pdf_hash, "PDF")
    mapping["page_count"] = page_count
    return mapping


def _input_path(path: Path, root: Path) -> Path:
    if not path.is_absolute():
        raise ReadQueryError(f"Recorded input path must be absolute: {path}")
    require_no_reparse_points(path)
    require_within(path, root)
    if not path.is_file():
        raise ReadQueryError(f"Recorded input is missing: {path}")
    return path


def _check_hash(path: Path, expected: str, label: str) -> None:
    if sha256_file(path) != expected:
        raise ReadQueryError(f"{label} hash changed; create a new run for the current version")


def _text(record: JsonObject, key: str) -> str:
    value = record.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ReadQueryError(f"Required run record field is missing or invalid: {key}")
    return value


def _object(value: object, label: str) -> JsonObject:
    if not isinstance(value, dict):
        raise ReadQueryError(f"Run record {label} must be an object")
    return cast(JsonObject, value)
