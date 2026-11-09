"""Validation and retrieval helpers for retained journal SQLite records.

The helpers in this module operate on a caller-owned SQLite connection.  They
never open a connection or commit a transaction; :class:`WorldStore` owns
those lifetimes and the atomic operation boundaries.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import cast

from research_file_workbench.common.filesystem import is_within, require_no_reparse_points
from research_file_workbench.common.hashing import sha256_bytes, sha256_text
from research_file_workbench.common.json_io import JsonObject, decode_json_object
from research_file_workbench.journals.checker import validate_check_result
from research_file_workbench.journals.models import validate_world_identity


class WorldStoreError(ValueError):
    """Raised when a library input or retained record cannot satisfy its contract."""


class BindingConflictError(WorldStoreError):
    """Raised when the expected project-world binding is no longer current."""


def check_root(root: Path, protected_roots: tuple[Path, ...]) -> None:
    """Reject library roots that overlap protected author input directories."""
    require_no_reparse_points(root)
    for protected in protected_roots:
        require_no_reparse_points(protected)
        if is_within(root, protected) or is_within(protected, root):
            raise WorldStoreError(
                "Journal library and protected input directories must not overlap"
            )


def require_text(value: object, name: str) -> str:
    """Return a nonblank string from an untrusted record value."""
    if not isinstance(value, str) or not value.strip():
        raise WorldStoreError(f"{name} must be a nonblank string")
    return value


def digest_id(value: object, prefix: str, name: str) -> str:
    """Validate a content-addressed identity with the expected prefix."""
    identity = require_text(value, name)
    if re.fullmatch(rf"{prefix}-[0-9a-f]{{64}}", identity) is None:
        raise WorldStoreError(f"{name} must be a content-addressed {prefix} identity")
    return identity


def source_references(world: JsonObject) -> dict[str, str]:
    """Validate and index the source manifest embedded in a world."""
    raw = world.get("sources")
    if not isinstance(raw, list) or not raw:
        raise WorldStoreError("World must retain its captured source references")
    references: dict[str, str] = {}
    for source in raw:
        if not isinstance(source, dict):
            raise WorldStoreError("World source reference must be an object")
        source_id = digest_id(source.get("source_id"), "source", "source_id")
        digest = require_text(source.get("sha256"), "source SHA-256")
        if source_id != f"source-{digest}":
            raise WorldStoreError("World source identity and hash disagree")
        references[source_id] = digest
    return references


def source_content(row: sqlite3.Row) -> bytes:
    """Return source bytes after verifying their stored content address."""
    content = bytes(row["content"])
    if sha256_bytes(content) != row["sha256"] or row["source_id"] != f"source-{row['sha256']}":
        raise WorldStoreError("Stored journal source content does not match its immutable identity")
    return content


def required_row(
    connection: sqlite3.Connection, table: str, identity: str, value: str
) -> sqlite3.Row:
    """Fetch one required row using a fixed internal table and column name."""
    row = connection.execute(f"SELECT * FROM {table} WHERE {identity}=?", (value,)).fetchone()
    if row is None:
        raise WorldStoreError(f"Requested {table} record does not exist")
    return cast(sqlite3.Row, row)


def verified_payload(row: sqlite3.Row) -> JsonObject:
    """Verify a retained JSON payload and its denormalized identity columns."""
    payload = require_text(row["payload"], "stored payload")
    if sha256_text(payload) != row["content_sha256"]:
        raise WorldStoreError("Stored journal record content changed")
    record = decode_json_object(payload)
    columns = set(row.keys())
    for identity in (
        "version_id",
        "journal_id",
        "binding_id",
        "check_id",
        "project_id",
        "world_version_id",
        "disposition_id",
        "previous_binding_id",
    ):
        if identity in columns and record.get(identity) != row[identity]:
            raise WorldStoreError("Stored journal record identity or binding changed")
    return record


def world_record(connection: sqlite3.Connection, row: sqlite3.Row) -> JsonObject:
    """Verify one world and all source links before returning its record."""
    record = verified_payload(row)
    validate_world_identity(record)
    sources = source_references(record)
    retained = {
        link["source_id"]
        for link in connection.execute(
            "SELECT source_id FROM world_source WHERE version_id=?", (row["version_id"],)
        )
    }
    if retained != set(sources):
        raise WorldStoreError("World source links do not match its immutable manifest")
    for source_id in sources:
        source_content(required_row(connection, "source", "source_id", source_id))
    return {
        **record,
        "version_ordinal": row["version_ordinal"],
        "created_at": row["created_at"],
    }


def current_binding(connection: sqlite3.Connection, project_id: str) -> JsonObject | None:
    """Resolve a project's current binding pointer, if it has one."""
    pointer = connection.execute(
        "SELECT binding_id FROM project_binding WHERE project_id=?",
        (project_id,),
    ).fetchone()
    if pointer is None:
        return None
    binding = verified_payload(
        required_row(connection, "binding", "binding_id", pointer["binding_id"])
    )
    if binding["project_id"] != project_id:
        raise WorldStoreError("Current binding belongs to another project")
    return binding


def check_record(connection: sqlite3.Connection, row: sqlite3.Row) -> JsonObject:
    """Verify a check against its retained binding, world and dependencies."""
    record = verified_payload(row)
    binding = verified_payload(
        required_row(
            connection,
            "binding",
            "binding_id",
            require_text(record.get("binding_id"), "binding_id"),
        )
    )
    if any(
        record.get(key) != binding[key] for key in ("project_id", "baseline_id", "world_version_id")
    ):
        raise WorldStoreError("Retained check differs from its immutable project binding")
    world = world_record(
        connection,
        required_row(
            connection,
            "world",
            "version_id",
            require_text(record.get("world_version_id"), "world_version_id"),
        ),
    )
    embedded_world = record.get("world")
    if embedded_world is not None:
        if not isinstance(embedded_world, dict):
            raise WorldStoreError("Historical check world must be a structured record")
        validate_world_identity(embedded_world)
        if embedded_world.get("version_id") != world["version_id"]:
            raise WorldStoreError("Historical check world differs from the retained version")
    validate_check_dependencies(record)
    validate_check_result(record, world)
    return record


def validate_check_dependencies(check: JsonObject) -> None:
    """Ensure a check records exactly the source and method versions it used."""
    dependencies = check.get("dependencies")
    if not isinstance(dependencies, dict):
        raise WorldStoreError("Check must retain explicit source and method dependencies")
    source_digest = require_text(check.get("source_sha256"), "source_sha256")
    expected = {
        "artifact_version_id": f"artifact-version-{source_digest}",
        "source_sha256": source_digest,
        "world_version_id": check["world_version_id"],
        "reader_version": require_text(check.get("reader_version"), "reader_version"),
        "checker_version": check["checker_version"],
        "completeness": "complete_for_declared_section_geometry",
    }
    if dependencies != expected:
        raise WorldStoreError("Check dependencies differ from its source, world or method bindings")
