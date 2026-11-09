"""Atomic project-to-world binding operations for the journal library."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from uuid import uuid4

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.filesystem import require_no_reparse_points
from research_file_workbench.common.hashing import sha256_text
from research_file_workbench.common.json_io import JsonObject, encode_json_object
from research_file_workbench.journals.store_records import (
    BindingConflictError,
    WorldStoreError,
    current_binding,
    require_text,
    required_row,
    verified_payload,
    world_record,
)


def bind_project(
    connection: sqlite3.Connection,
    project_id: str,
    project_root: str,
    baseline_id: str,
    world_version_id: str,
    *,
    expected_binding_id: str | None,
    actor_id: str,
    surface: str,
) -> JsonObject:
    """Compare and switch a project's immutable world binding in one transaction."""
    for name, value in (
        ("project_id", project_id),
        ("baseline_id", baseline_id),
        ("actor_id", actor_id),
        ("surface", surface),
    ):
        require_text(value, name)
    path = Path(require_text(project_root, "project_root"))
    if not path.is_absolute():
        raise WorldStoreError("Project root must be absolute")
    require_no_reparse_points(path)
    normalized_root = path.resolve().as_posix()
    world_record(connection, required_row(connection, "world", "version_id", world_version_id))
    current = current_binding(connection, project_id)
    if current is not None and _is_binding_retry(
        current, normalized_root, baseline_id, world_version_id, expected_binding_id, actor_id
    ):
        return current
    current_id = current["binding_id"] if current is not None else None
    if current_id != expected_binding_id:
        raise BindingConflictError("Project world binding changed; inspect it before rebinding")
    binding: JsonObject = {
        "binding_id": f"binding-{uuid4().hex}",
        "project_id": project_id,
        "project_root": normalized_root,
        "baseline_id": baseline_id,
        "world_version_id": world_version_id,
        "previous_binding_id": current_id,
        "actor_id": actor_id,
        "surface": surface,
        "created_at": utc_now_iso(),
    }
    _insert_binding(connection, binding)
    return binding


def get_binding(connection: sqlite3.Connection, project_id: str) -> JsonObject | None:
    """Return the explicitly selected current binding, if one exists."""
    return current_binding(connection, project_id)


def list_bindings(
    connection: sqlite3.Connection, project_id: str | None = None
) -> list[JsonObject]:
    """List retained binding history, optionally limited to one project."""
    rows = connection.execute(
        "SELECT * FROM binding"
        + (" WHERE project_id=?" if project_id is not None else "")
        + " ORDER BY rowid",
        (project_id,) if project_id is not None else (),
    )
    return [verified_payload(row) for row in rows]


def _is_binding_retry(
    current: JsonObject,
    project_root: str,
    baseline_id: str,
    world_version_id: str,
    expected_binding_id: str | None,
    actor_id: str,
) -> bool:
    same_target = all(
        current[key] == value
        for key, value in (
            ("project_root", project_root),
            ("baseline_id", baseline_id),
            ("world_version_id", world_version_id),
        )
    )
    expected_current = expected_binding_id == current["binding_id"]
    same_actor_retry = (
        expected_binding_id == current["previous_binding_id"] and actor_id == current["actor_id"]
    )
    return same_target and (expected_current or same_actor_retry)


def _insert_binding(connection: sqlite3.Connection, binding: JsonObject) -> None:
    payload = encode_json_object(binding)
    connection.execute(
        "INSERT INTO binding VALUES (?,?,?,?,?,?)",
        (
            binding["binding_id"],
            binding["project_id"],
            binding["world_version_id"],
            binding["previous_binding_id"],
            sha256_text(payload),
            payload,
        ),
    )
    connection.execute(
        "INSERT INTO project_binding VALUES (?,?) ON CONFLICT(project_id) "
        "DO UPDATE SET binding_id=excluded.binding_id",
        (binding["project_id"], binding["binding_id"]),
    )
