"""Atomic world and captured-source operations for :mod:`journals.store`."""

from __future__ import annotations

import sqlite3

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.hashing import sha256_bytes, sha256_text
from research_file_workbench.common.json_io import JsonObject, encode_json_object
from research_file_workbench.journals.analysis import validate_world_sources
from research_file_workbench.journals.models import validate_world_identity
from research_file_workbench.journals.store_records import (
    WorldStoreError,
    digest_id,
    require_text,
    required_row,
    source_content,
    source_references,
    world_record,
)


def save_world(
    connection: sqlite3.Connection, world: JsonObject, sources: dict[str, bytes]
) -> JsonObject:
    """Retain a world and its source bytes using the caller's transaction."""
    version_id = digest_id(world.get("version_id"), "world", "version_id")
    journal_id = require_text(world.get("journal_id"), "journal_id")
    if {"created_at", "version_ordinal"}.intersection(world):
        raise WorldStoreError("World inputs must not include library-assigned metadata")
    validate_world_identity(world)
    payload = encode_json_object(world)
    references = source_references(world)
    if set(references) != set(sources):
        raise WorldStoreError("World source references and supplied bytes must match exactly")
    if any(
        not isinstance(sources[source_id], bytes) or sha256_bytes(sources[source_id]) != digest
        for source_id, digest in references.items()
    ):
        raise WorldStoreError("Journal source bytes do not match their declared hash")
    existing = connection.execute(
        "SELECT * FROM world WHERE version_id=?", (version_id,)
    ).fetchone()
    if existing is not None:
        saved = world_record(connection, existing)
        if existing["payload"] != payload:
            raise WorldStoreError("World version already identifies different content")
        return saved
    validate_world_sources(world, sources)
    for source_id, digest in references.items():
        content = sources[source_id]
        existing = connection.execute(
            "SELECT * FROM source WHERE source_id=?", (source_id,)
        ).fetchone()
        if existing is None:
            connection.execute("INSERT INTO source VALUES (?,?,?)", (source_id, digest, content))
        elif source_content(existing) != content:
            raise WorldStoreError("Source identity already identifies different bytes")
    ordinal = connection.execute(
        "SELECT COALESCE(MAX(version_ordinal),0)+1 FROM world WHERE journal_id=?",
        (journal_id,),
    ).fetchone()[0]
    connection.execute(
        "INSERT INTO world VALUES (?,?,?,?,?,?)",
        (version_id, journal_id, ordinal, utc_now_iso(), sha256_text(payload), payload),
    )
    connection.executemany(
        "INSERT INTO world_source VALUES (?,?)",
        [(version_id, source_id) for source_id in references],
    )
    return world_record(connection, required_row(connection, "world", "version_id", version_id))


def get_world(connection: sqlite3.Connection, version_id: str) -> JsonObject:
    """Recover and verify one exact world version."""
    return world_record(connection, required_row(connection, "world", "version_id", version_id))


def list_worlds(connection: sqlite3.Connection) -> list[JsonObject]:
    """List world metadata without selecting a project binding implicitly."""
    worlds = [
        world_record(connection, row)
        for row in connection.execute("SELECT * FROM world ORDER BY rowid")
    ]
    return [
        {key: world[key] for key in ("version_id", "journal_id", "version_ordinal", "created_at")}
        | {key: world[key] for key in ("journal_name", "scope")}
        for world in worlds
    ]


def read_source(connection: sqlite3.Connection, source_id: str) -> bytes:
    """Recover source bytes after checking their content-addressed identity."""
    return source_content(required_row(connection, "source", "source_id", source_id))
