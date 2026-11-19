"""Expose retained manuscript versions, source objects and exact reading records."""

import base64
from pathlib import Path
from typing import cast

from research_file_workbench.common.filesystem import require_no_reparse_points
from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import JsonObject, load_json_object
from research_file_workbench.docx.query import ReadQuery, ReadQueryError
from research_file_workbench.docx.read_receipt import ReadCaller
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.projects.models import ProjectStoreError
from research_file_workbench.projects.service import catalog_project, open_project, read_project


def manuscript_workspace(project_root: Path, baseline_id: str | None) -> JsonObject:
    """Return a coherent selected baseline without recording catalog discovery as a read."""
    store = open_project(project_root)
    baseline = store.get_baseline(baseline_id)
    selected_id = cast(str, baseline["baseline_id"])
    expected_current = (
        selected_id if baseline_id is None else cast(str, store.info()["current_baseline_id"])
    )
    with store.guard_baseline(expected_current):
        return {
            "baseline": baseline,
            "baselines": store.list_baselines(),
            "catalog": catalog_project(project_root, baseline_id=selected_id),
            "evidence": store.list_evidence(selected_id, reader_version=READER_VERSION),
            "render_bundles": store.list_render_bundles(selected_id),
            "reads": store.list_reads(selected_id),
        }


def manuscript_source(project_root: Path, baseline_id: str) -> JsonObject:
    """Return exact retained source bytes for one explicitly selected baseline."""
    store = open_project(project_root)
    baseline = store.get_baseline(baseline_id)
    artifact_id = cast(list[str], baseline["artifact_version_ids"])[0]
    content = store.read_artifact(artifact_id)
    source_sha256 = cast(str, baseline["source_sha256"])
    if sha256_bytes(content) != source_sha256:
        raise ProjectStoreError("Stored manuscript source differs from its baseline identity")
    return {
        "project_id": baseline["project_id"],
        "baseline_id": baseline["baseline_id"],
        "source_sha256": source_sha256,
        "filename": _source_filename(project_root, baseline),
        "content_base64": base64.b64encode(content).decode("ascii"),
    }


def read_manuscript(
    project_root: Path,
    query: ReadQuery,
    baseline_id: str | None,
    render_bundle_id: str | None,
    *,
    client_id: str = "research-workbench",
    caller: ReadCaller | None = None,
) -> JsonObject:
    """Read through the existing query engine and retain its exact delivery receipt.

    `client_id` labels the transport that asked, so a retained receipt distinguishes a desktop
    read from an agent read. It is set by the serving surface, never supplied by a caller.
    """
    if query.page_number is not None:
        if render_bundle_id is None:
            raise ReadQueryError("Physical-page reading requires a selected evidence bundle")
        store = open_project(project_root)
        selected = store.get_baseline(baseline_id)
        bundle = store.get_render_bundle(cast(str, selected["baseline_id"]), render_bundle_id)
        manifest = cast(JsonObject, bundle["manifest"])
        if manifest["mapping"] is None:
            raise ReadQueryError("Independent page mapping is not available")
    return read_project(
        project_root,
        query,
        baseline_id=baseline_id,
        render_bundle_id=render_bundle_id,
        client_id=client_id,
        caller=caller,
    )


def _source_filename(project_root: Path, baseline: JsonObject) -> str:
    provenance = baseline.get("source_path")
    if isinstance(provenance, str):
        filename = provenance.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
        if filename.lower().endswith(".docx"):
            return filename
    display_path = project_root / "display.json"
    require_no_reparse_points(display_path)
    display = load_json_object(display_path)
    name = display.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ProjectStoreError("Persistent project display name is invalid")
    safe_name = name.strip().replace("/", "-").replace("\\", "-").replace(":", "-")
    return f"{safe_name}.docx"
