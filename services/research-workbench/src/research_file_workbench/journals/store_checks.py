"""Atomic check and operator-disposition operations for the journal library."""

from __future__ import annotations

import sqlite3
from typing import cast
from uuid import uuid4

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.hashing import sha256_text
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.journals.checker import validate_check_result
from research_file_workbench.journals.models import CHECKER_VERSION, validate_world_for_execution
from research_file_workbench.journals.store_records import (
    BindingConflictError,
    WorldStoreError,
    check_record,
    current_binding,
    require_text,
    required_row,
    validate_check_dependencies,
    verified_payload,
    world_record,
)


def save_check(connection: sqlite3.Connection, check: JsonObject) -> JsonObject:
    """Retain an immutable check while its exact project binding is current."""
    check_id = require_text(check.get("check_id"), "check_id")
    _validate_check_identity(check)
    payload = encode_json_object(check)
    existing = connection.execute(
        "SELECT * FROM check_record WHERE check_id=?", (check_id,)
    ).fetchone()
    if existing is not None:
        saved = check_record(connection, existing)
        if existing["payload"] != payload:
            raise WorldStoreError("Check identity already identifies different content")
        return saved
    _validate_new_check(connection, check)
    _insert_check(connection, check, check_id, payload)
    return decode_json_object(payload)


def _validate_new_check(connection: sqlite3.Connection, check: JsonObject) -> None:
    if "world" in check:
        raise WorldStoreError("New checks must reference the retained world, not duplicate it")
    if {"validity", "stale_reasons", "update_available", "dispositions"}.intersection(check):
        raise WorldStoreError(
            "New checks must not persist derived validity, updates or dispositions"
        )
    binding = current_binding(connection, require_text(check["project_id"], "project_id"))
    if binding is None or any(
        binding[name] != check[name] for name in ("binding_id", "baseline_id", "world_version_id")
    ):
        raise BindingConflictError(
            "Check binding is no longer current; check the selected binding again"
        )
    template_check = "template_comparison" in check
    if template_check:
        from research_file_workbench.journals.template_models import TEMPLATE_CHECKER_VERSION

        if check["checker_version"] != TEMPLATE_CHECKER_VERSION:
            raise WorldStoreError("New template checks must use the current method")
    if not template_check and check["checker_version"] != CHECKER_VERSION:
        raise WorldStoreError("New checks must use the current checker method")
    if not template_check and check.get("reader_version") != READER_VERSION:
        raise WorldStoreError("New checks must use the current reader method")
    validate_check_dependencies(check)
    world = world_record(
        connection,
        required_row(
            connection,
            "world",
            "version_id",
            require_text(check["world_version_id"], "world_version_id"),
        ),
    )
    validate_world_for_execution(world)
    validate_check_result(check, world)


def _validate_check_identity(check: JsonObject) -> None:
    for name in (
        "project_id",
        "baseline_id",
        "binding_id",
        "world_version_id",
        "checker_version",
    ):
        require_text(check.get(name), name)


def _insert_check(
    connection: sqlite3.Connection, check: JsonObject, check_id: str, payload: str
) -> None:
    connection.execute(
        "INSERT INTO check_record VALUES (?,?,?,?,?,?)",
        (
            check_id,
            check["project_id"],
            check["binding_id"],
            check["world_version_id"],
            sha256_text(payload),
            payload,
        ),
    )


def get_check(connection: sqlite3.Connection, check_id: str) -> JsonObject:
    """Return a retained check without rewriting its original conclusion."""
    return check_record(connection, required_row(connection, "check_record", "check_id", check_id))


def list_checks(
    connection: sqlite3.Connection,
    project_id: str | None = None,
    *,
    binding_id: str | None = None,
) -> list[JsonObject]:
    """List retained checks filtered by project and exact binding."""
    filters: list[str] = []
    arguments: list[str] = []
    for name, value in (("project_id", project_id), ("binding_id", binding_id)):
        if value is not None:
            filters.append(f"{name}=?")
            arguments.append(value)
    rows = connection.execute(
        "SELECT * FROM check_record"
        + (" WHERE " + " AND ".join(filters) if filters else "")
        + " ORDER BY rowid",
        arguments,
    )
    return [check_record(connection, row) for row in rows]


def record_disposition(
    connection: sqlite3.Connection,
    check_id: str,
    rule_id: str,
    action: str,
    note: str,
    actor_id: str,
    *,
    surface: str,
) -> JsonObject:
    """Append an operator note or deferral while preserving the original verdict."""
    if action not in ("note", "defer"):
        raise WorldStoreError(
            "Disposition action must be note or defer; verdicts cannot be overridden"
        )
    require_text(note, "note")
    require_text(actor_id, "actor_id")
    require_text(surface, "surface")
    check = check_record(connection, required_row(connection, "check_record", "check_id", check_id))
    rules = {
        require_text(item["rule_id"], "rule_id"): item
        for item in cast(list[JsonObject], check["rule_results"])
    }
    if rule_id not in rules:
        raise WorldStoreError("Disposition rule does not belong to the selected check")
    record: JsonObject = {
        "disposition_id": f"disposition-{uuid4().hex}",
        "check_id": check_id,
        "rule_id": rule_id,
        "action": action,
        "note": note,
        "actor_id": actor_id,
        "surface": surface,
        "created_at": utc_now_iso(),
        "verdict": rules[rule_id]["verdict"],
    }
    payload = encode_json_object(record)
    connection.execute(
        "INSERT INTO disposition VALUES (?,?,?,?)",
        (record["disposition_id"], check_id, sha256_text(payload), payload),
    )
    return record


def list_dispositions(connection: sqlite3.Connection, check_id: str) -> list[JsonObject]:
    """List chronological operator dispositions for one retained check."""
    check_record(connection, required_row(connection, "check_record", "check_id", check_id))
    return [
        verified_payload(row)
        for row in connection.execute(
            "SELECT * FROM disposition WHERE check_id=? ORDER BY rowid", (check_id,)
        )
    ]
