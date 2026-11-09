"""Expose retained manuscript versions, source objects and exact reading records."""

from pathlib import Path
from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.query import ReadQuery, ReadQueryError
from research_file_workbench.docx.read_receipt import ReadCaller
from research_file_workbench.docx.report import READER_VERSION
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
