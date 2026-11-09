"""Persist exact read deliveries and enforce their source and page evidence bindings."""

import sqlite3
from typing import cast

from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.docx.query import ReadQueryError, validate_query_delivery
from research_file_workbench.docx.read_receipt import ReadReceipt
from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.projects.artifact_records import read_artifact
from research_file_workbench.projects.baseline_records import get_baseline
from research_file_workbench.projects.evidence_records import get_render_bundle
from research_file_workbench.projects.models import (
    BaselineConflictError,
    ProjectStoreError,
    require_record_text,
)
from research_file_workbench.projects.project_database import project_info


def save_read(
    connection: sqlite3.Connection,
    *,
    baseline_id: str,
    require_current: bool,
    task: JsonObject,
    response: JsonObject,
) -> None:
    """Save the exact response and task together, refusing a displaced required baseline."""
    receipt = ReadReceipt.from_json(response.get("read_receipt"))
    task_id = require_record_text(task.get("task_id"), "task_id")
    if receipt.task_id != task_id or task.get("baseline_id") != baseline_id:
        raise ProjectStoreError("Task, receipt, and baseline identities disagree")
    if task.get("actual_read_ranges") != [item.to_json() for item in receipt.ranges]:
        raise ProjectStoreError("Task read ranges differ from its delivered receipt")
    if task.get("status") not in ("completed", "partial"):
        raise ProjectStoreError("Delivered read task must be completed or partial")
    if response.get("status") != task["status"]:
        raise ProjectStoreError("Read response status differs from its task")
    if not isinstance(task.get("scope"), dict) or not isinstance(
        task.get("unresolved_items"), list
    ):
        raise ProjectStoreError("Read task requires scope and unresolved items")
    baseline = get_baseline(connection, baseline_id)
    project = project_info(connection)
    if require_current and project["current_baseline_id"] != baseline_id:
        raise BaselineConflictError("Current reading baseline changed before delivery")
    response_project = response.get("project")
    if (
        not isinstance(response_project, dict)
        or response_project.get("project_id") != project["project_id"]
        or response_project.get("baseline_id") != baseline_id
    ):
        raise ProjectStoreError("Read response project and baseline identities disagree")
    if response.get("query_scope") != task["scope"]:
        raise ProjectStoreError("Task scope differs from the returned query scope")
    scope = cast(JsonObject, task["scope"])
    page_mapping: JsonObject | None = None
    if scope.get("page_number") is not None:
        page_context = response.get("render_bundle")
        if not isinstance(page_context, dict):
            raise ProjectStoreError("Page read response is missing its registered bundle")
        bundle_id = require_record_text(page_context.get("bundle_id"), "bundle_id")
        bundle = get_render_bundle(connection, baseline_id, bundle_id)
        manifest = cast(JsonObject, bundle["manifest"])
        if (
            bundle_id not in receipt.dependencies
            or manifest.get("pdf_sha256") != page_context.get("pdf_sha256")
            or manifest.get("render_profile_id") != page_context.get("render_profile_id")
            or manifest.get("reader_version") != response.get("reader_version")
            or not isinstance(manifest.get("mapping"), dict)
        ):
            raise ProjectStoreError("Page read evidence binding differs from its bundle")
        for raw in cast(list[JsonObject], manifest["artifacts"]):
            read_artifact(connection, require_record_text(raw["version_id"], "version_id"))
        page_mapping = {**cast(JsonObject, manifest["mapping"]), "render_bundle_id": bundle_id}
    response_project["baseline_is_current"] = project["current_baseline_id"] == baseline_id
    versions = cast(list[str], baseline["artifact_version_ids"])
    if any(item.version_id not in versions for item in receipt.ranges + receipt.unread_ranges):
        raise ProjectStoreError("Read receipt contains a version outside its baseline")
    source = response.get("source")
    if (
        not isinstance(source, dict)
        or source.get("version_id") not in versions
        or source.get("sha256") != baseline["source_sha256"]
    ):
        raise ProjectStoreError("Read response source does not match its baseline")
    version_id = require_record_text(source["version_id"], "version_id")
    result = read_docx_bytes(read_artifact(connection, version_id), source_label=version_id)
    try:
        validate_query_delivery(
            result, response, receipt, page_mapping=page_mapping, baseline_id=baseline_id
        )
    except ReadQueryError as exc:
        raise ProjectStoreError(f"Read delivery is inconsistent: {exc}") from exc
    connection.execute(
        "INSERT INTO task VALUES (?,?,?)", (task_id, baseline_id, encode_json_object(task))
    )
    connection.execute(
        "INSERT INTO read_record VALUES (?,?,?)",
        (receipt.read_record_id, task_id, encode_json_object(response)),
    )


def get_read(connection: sqlite3.Connection, read_record_id: str) -> JsonObject:
    """Return the original persisted response without rebinding its historical receipt."""
    row = connection.execute(
        "SELECT response_json FROM read_record WHERE read_record_id=?", (read_record_id,)
    ).fetchone()
    if row is None:
        raise ProjectStoreError("Read record does not exist")
    return decode_json_object(row["response_json"])


def list_reads(connection: sqlite3.Connection, baseline_id: str | None = None) -> list[JsonObject]:
    """Return delivery summaries; omit baseline_id to list all historical deliveries."""
    query = (
        "SELECT r.read_record_id,t.task_id,t.baseline_id,r.response_json"
        " FROM read_record r JOIN task t ON r.task_id=t.task_id"
    )
    parameters: tuple[str, ...] = ()
    if baseline_id is not None:
        get_baseline(connection, baseline_id)
        query += " WHERE t.baseline_id=?"
        parameters = (baseline_id,)
    items: list[JsonObject] = []
    for row in connection.execute(query + " ORDER BY r.rowid", parameters):
        response = decode_json_object(row["response_json"])
        receipt = cast(JsonObject, response["read_receipt"])
        items.append(
            {
                "read_record_id": row["read_record_id"],
                "task_id": row["task_id"],
                "baseline_id": row["baseline_id"],
                "created_at": receipt["created_at"],
                "query_scope": response.get("query_scope"),
                "status": response.get("status"),
            }
        )
    return items
