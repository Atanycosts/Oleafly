"""Local project operations backed by immutable SQLite records and DOCX snapshots."""

from pathlib import Path
from tempfile import TemporaryDirectory
from typing import cast
from uuid import uuid4

from research_file_workbench.common.filesystem import (
    PathBoundaryError,
    is_within,
    require_no_reparse_points,
    require_within,
)
from research_file_workbench.common.hashing import sha256_bytes, sha256_file, sha256_text
from research_file_workbench.common.json_io import JsonObject, encode_json_object
from research_file_workbench.docx.models import DocxReadError, DocxReadResult
from research_file_workbench.docx.query import (
    ReadQuery,
    catalog_docx,
    object_observations,
    query_docx,
)
from research_file_workbench.docx.read_receipt import ReadCaller
from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.projects.models import (
    BaselineConflictError,
    BaselineRequest,
    ProjectStoreError,
)
from research_file_workbench.projects.store import ProjectStore

DATABASE_NAME = "project.sqlite3"


def create_project(
    project_root: Path, *, author_workspace_root: Path, project_id: str | None = None
) -> JsonObject:
    """Create an explicitly selected application project outside the protected author root."""
    _check_boundaries(project_root, author_workspace_root)
    if not author_workspace_root.is_dir():
        raise ProjectStoreError("Author workspace must exist before project creation")
    if project_root.exists():
        raise FileExistsError(f"Project location already exists: {project_root}")
    project_root.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".rfw-project-", dir=project_root.parent) as temporary:
        staging = Path(temporary)
        ProjectStore.create(
            staging / DATABASE_NAME,
            project_id=project_id if project_id is not None else f"project-{uuid4().hex}",
            author_workspace_root=author_workspace_root.resolve().as_posix(),
        )
        _check_boundaries(project_root, author_workspace_root)
        if project_root.exists():
            raise FileExistsError(f"Project location already exists: {project_root}")
        staging.rename(project_root)
    return open_project(project_root).info()


def open_project(project_root: Path) -> ProjectStore:
    """Open a registered project after checking its persistent paths and recorded author root."""
    _check_database_paths(project_root)
    database = project_root / DATABASE_NAME
    if not database.is_file():
        raise ProjectStoreError(f"No project database at {database}; initialize a project first")
    store = ProjectStore(database)
    author_root = Path(_text(store.inspect_identity(), "author_workspace_root"))
    _check_boundaries(project_root, author_root)
    return store


def inspect_import(project_root: Path, source: Path) -> JsonObject:
    """Describe a proposed import without changing the project or treating it as approval."""
    store = open_project(project_root)
    info = store.info()
    _check_source(source, Path(_text(info, "author_workspace_root")))
    digest = sha256_file(source)
    return {
        "project_id": info["project_id"],
        "expected_baseline_id": info["current_baseline_id"],
        "source_path": source.resolve().as_posix(),
        "source_sha256": digest,
        "artifact_version_id": f"artifact-version-{digest}",
        "verification_status": "NOT_REVIEWED",
        "limitations": [
            "This inspection does not create a baseline or confirm the manuscript's contents."
        ],
    }


def import_document(
    project_root: Path,
    source: Path,
    *,
    source_sha256: str,
    request_id: str,
    expected_baseline_id: str | None,
    actor_id: str,
    confirmation_reason: str,
) -> JsonObject:
    """Apply a local operator's version-bound import with idempotent result recovery.

    The confirmed hash is required so replay never needs to reopen an author file that has
    moved or changed. A different request needs a fresh hash and expected baseline.
    """
    if not confirmation_reason.strip():
        raise ProjectStoreError("Record the local operator's reason for this baseline decision")
    store = open_project(project_root)
    info = store.info()
    request = BaselineRequest(
        project_id=_text(info, "project_id"),
        actor_id=actor_id,
        request_id=request_id,
        expected_baseline_id=expected_baseline_id,
        source_sha256=source_sha256,
    )
    previous = store.lookup_request(actor_id, request_id, request.request_digest)
    if previous is not None:
        return previous
    author_root = Path(_text(info, "author_workspace_root"))
    try:
        _check_source(source, author_root)
        if sha256_file(source) != source_sha256:
            raise ProjectStoreError(
                "Author source differs from the confirmed hash; inspect it again"
            )
        payload = source.read_bytes()
        if sha256_bytes(payload) != source_sha256:
            raise ProjectStoreError("Author source changed while capturing the confirmed version")
        result = read_docx_bytes(payload, source_label=source.resolve().as_posix())
        evidence = _source_evidence(result)
        if sha256_file(source) != source_sha256:
            raise ProjectStoreError(
                "Author source changed before baseline submission; inspect again"
            )
    except (DocxReadError, ProjectStoreError, PathBoundaryError) as exc:
        _check_database_paths(project_root)
        return store.record_rejection(
            request,
            source_path=source.resolve().as_posix(),
            confirmation_reason=confirmation_reason,
            reason=str(exc),
        )
    _check_database_paths(project_root)
    return store.apply_baseline(
        request,
        source_bytes=payload,
        source_path=source.resolve().as_posix(),
        confirmation_reason=confirmation_reason,
        evidence=evidence,
        reader_version=READER_VERSION,
    )


def catalog_project(project_root: Path, *, baseline_id: str | None = None) -> JsonObject:
    """List source objects at a selected project baseline without a content-read receipt."""
    store = open_project(project_root)
    baseline = store.get_baseline(baseline_id)
    result = _read_baseline(store, baseline)
    catalog = catalog_docx(result)
    _check_current(store, baseline, required=baseline_id is None)
    catalog["project"] = _project_context(store, baseline)
    return catalog


def import_captured_document(
    project_root: Path,
    content: bytes,
    *,
    filename: str,
    request_id: str,
    expected_baseline_id: str,
    confirmation_reason: str,
) -> JsonObject:
    """Apply a user-selected byte snapshot without reopening or writing an author path.

    The existing baseline transaction owns replay, compare-and-swap and evidence storage.
    A basename is retained as provenance only; it is never used to resolve a local file.
    """
    if not confirmation_reason.strip():
        raise ProjectStoreError("请填写版本更新原因。")
    if (
        not filename
        or Path(filename).name != filename
        or any(character in filename for character in ("/", "\\", ":", "\0"))
        or Path(filename).suffix.lower() != ".docx"
    ):
        raise ProjectStoreError("请选择 DOCX 文件。")
    store = open_project(project_root)
    request = BaselineRequest(
        project_id=_text(store.info(), "project_id"),
        actor_id="local-operator",
        request_id=request_id,
        expected_baseline_id=expected_baseline_id,
        source_sha256=sha256_bytes(content),
    )
    previous = store.lookup_request(request.actor_id, request_id, request.request_digest)
    if previous is not None:
        return previous
    try:
        result = read_docx_bytes(content, source_label=filename)
        if any(part.status == "failed" for part in result.parts):
            raise DocxReadError("论文包含无法解析的内容，请检查源文件。")
        evidence = _source_evidence(result)
    except DocxReadError as exc:
        return store.record_rejection(
            request,
            source_path=filename,
            confirmation_reason=confirmation_reason,
            reason=str(exc),
        )
    return store.apply_baseline(
        request,
        source_bytes=content,
        source_path=filename,
        confirmation_reason=confirmation_reason,
        evidence=evidence,
        reader_version=READER_VERSION,
    )


def read_project(
    project_root: Path,
    query: ReadQuery,
    *,
    baseline_id: str | None = None,
    render_bundle_id: str | None = None,
    actor_id: str = "local-operator",
    client_id: str = "rfw-project",
    caller: ReadCaller | None = None,
) -> JsonObject:
    """Persist a query response, task and exact receipt in one commit before returning it.

    A current-baseline change during reading rejects the response. Explicit historical reads
    stay bound to their requested baseline. Physical-page selection requires an explicit
    registered bundle with independent mapping; no newest-version selection is inferred.
    """
    if query.page_number is not None and render_bundle_id is None:
        raise ProjectStoreError("Project page queries require an explicit registered render bundle")
    if query.page_number is None and render_bundle_id is not None:
        raise ProjectStoreError("Select a physical page when supplying a render bundle")
    store = open_project(project_root)
    baseline = store.get_baseline(baseline_id)
    result = _read_baseline(store, baseline)
    mapping: JsonObject | None = None
    if render_bundle_id is not None:
        from research_file_workbench.projects.render_service import load_render_mapping

        mapping = load_render_mapping(store, _text(baseline, "baseline_id"), render_bundle_id)
    task_id = f"task-{uuid4().hex}"
    response = query_docx(
        result,
        query,
        task_id=task_id,
        actor_id=actor_id,
        client_id=client_id,
        caller=caller,
        baseline_id=_text(baseline, "baseline_id"),
        page_mapping=mapping,
    )
    if mapping is not None:
        response["render_bundle"] = {
            "bundle_id": render_bundle_id,
            "pdf_sha256": mapping["pdf_sha256"],
            "render_profile_id": mapping["render_profile_id"],
            "page_count": mapping["page_count"],
        }
    response["project"] = _project_context(store, baseline)
    response["verification_status"] = "NOT_REVIEWED"
    receipt = _object(response["read_receipt"])
    response["delivery"] = {
        "kind": "persistent_project_response",
        "read_record_id": receipt["read_record_id"],
        "limitations": [
            "The saved response records delivery content, not visual or semantic understanding."
        ],
    }
    task: JsonObject = {
        "task_id": task_id,
        "baseline_id": baseline["baseline_id"],
        "scope": response["query_scope"],
        "status": response["status"],
        "actual_read_ranges": receipt["ranges"],
        "unresolved_items": response["limitations"],
    }
    _check_database_paths(project_root)
    store.save_read(
        baseline_id=_text(baseline, "baseline_id"),
        require_current=baseline_id is None,
        task=task,
        response=response,
    )
    return response


def _source_evidence(result: DocxReadResult) -> list[JsonObject]:
    version_id = f"artifact-version-{result.source_sha256}"
    evidence: list[JsonObject] = []
    for item in object_observations(result):
        content = _object(item["content"])
        content_hash = sha256_text(encode_json_object(content))
        identity = sha256_text(f"{item['object_id']}:{content_hash}:{READER_VERSION}")
        evidence.append(
            {
                "evidence_id": f"evidence-{identity}",
                "evidence_version": f"evidence-version-{identity}",
                "kind": "source_observation",
                "artifact_version_id": version_id,
                "object_locator": {
                    "object_id": item["object_id"],
                    "node_locator": item["range_locator"],
                    "part_path": item["part_path"],
                },
                "statement": (
                    f"Source {item['object_type']} observation; not independently verified."
                ),
                "scope": {"object_type": item["object_type"], "region": item["region"]},
                "value": content,
                "unit": None,
                "content_hash": content_hash,
                "parse_status": content["parse_status"],
                "limitations": content.get("limitations", []),
                "dependencies": [version_id, READER_VERSION],
                "extraction_method": "docx_structure_observation",
                "extraction_method_version": READER_VERSION,
                "verification_record_ids": [],
            }
        )
    return evidence


def _read_baseline(store: ProjectStore, baseline: JsonObject) -> DocxReadResult:
    version_id = f"artifact-version-{_text(baseline, 'source_sha256')}"
    return read_docx_bytes(store.read_artifact(version_id), source_label=version_id)


def _project_context(store: ProjectStore, baseline: JsonObject) -> JsonObject:
    info = store.info()
    return {
        "project_id": info["project_id"],
        "baseline_id": baseline["baseline_id"],
        "baseline_is_current": baseline["baseline_id"] == info["current_baseline_id"],
        "baseline_reader_version": baseline["reader_version"],
        "response_reader_version": READER_VERSION,
    }


def _check_current(store: ProjectStore, baseline: JsonObject, *, required: bool) -> None:
    if required and store.info()["current_baseline_id"] != baseline["baseline_id"]:
        raise BaselineConflictError("Current baseline changed while reading; query it again")


def _check_source(source: Path, author_root: Path) -> None:
    require_no_reparse_points(source)
    require_within(source, author_root)
    if not source.is_file() or source.suffix.lower() != ".docx":
        raise ProjectStoreError("The import source must be a DOCX file inside the author workspace")


def _check_boundaries(project_root: Path, author_root: Path) -> None:
    require_no_reparse_points(project_root)
    require_no_reparse_points(author_root)
    if is_within(project_root, author_root) or is_within(author_root, project_root):
        raise ProjectStoreError("Project storage and the author workspace must not overlap")


def _check_database_paths(project_root: Path) -> None:
    require_no_reparse_points(project_root)
    for suffix in ("", "-journal", "-wal", "-shm"):
        path = project_root / f"{DATABASE_NAME}{suffix}"
        require_no_reparse_points(path)
        if path.exists() and path.stat().st_nlink > 1:
            raise ProjectStoreError("Writable database files must not have multiple hard links")


def _text(record: JsonObject, field: str) -> str:
    value = record.get(field)
    if not isinstance(value, str) or not value:
        raise ProjectStoreError(f"Persistent record has an invalid {field}")
    return value


def _object(value: object) -> JsonObject:
    if not isinstance(value, dict):
        raise ProjectStoreError("Expected a structured observation or receipt")
    return cast(JsonObject, value)
