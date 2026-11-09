"""SQLite schema, connection lifetime and fixed project ownership."""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.projects.models import (
    BaselineRequest,
    ProjectStoreError,
    require_record_text,
)

_SCHEMA_VERSION = 2
_BUSY_TIMEOUT_MS = 5000
# The version-1 statements stay frozen: a database created by an earlier build is upgraded in
# place, never rebuilt, so the rows it already holds keep their original bytes.
_SCHEMA = (
    (
        "CREATE TABLE project (project_id TEXT PRIMARY KEY, author_workspace_root TEXT "
        "NOT NULL, current_baseline_id TEXT REFERENCES baseline(baseline_id), created_at "
        "TEXT NOT NULL)"
    ),
    (
        "CREATE TABLE artifact (version_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, "
        "content BLOB NOT NULL)"
    ),
    (
        "CREATE TABLE baseline (baseline_id TEXT PRIMARY KEY, artifact_version_id TEXT "
        "NOT NULL REFERENCES artifact(version_id), payload TEXT NOT NULL)"
    ),
    (
        "CREATE TABLE baseline_request (actor_id TEXT NOT NULL, request_id TEXT NOT NULL, "
        "request_digest TEXT NOT NULL, request_json TEXT NOT NULL, decision_json TEXT NOT "
        "NULL, result_json TEXT NOT NULL, PRIMARY KEY(actor_id, request_id))"
    ),
    (
        "CREATE TABLE request_conflict (attempt_id INTEGER PRIMARY KEY, actor_id TEXT NOT "
        "NULL, request_id TEXT NOT NULL, request_digest TEXT NOT NULL, result_json TEXT "
        "NOT NULL, FOREIGN KEY(actor_id,request_id) REFERENCES "
        "baseline_request(actor_id,request_id))"
    ),
    (
        "CREATE TABLE evidence (evidence_version TEXT PRIMARY KEY, artifact_version_id "
        "TEXT NOT NULL REFERENCES artifact(version_id), payload TEXT NOT NULL)"
    ),
    (
        "CREATE TABLE baseline_evidence (baseline_id TEXT NOT NULL REFERENCES "
        "baseline(baseline_id), evidence_version TEXT NOT NULL REFERENCES "
        "evidence(evidence_version), PRIMARY KEY(baseline_id,evidence_version))"
    ),
    (
        "CREATE TABLE task (task_id TEXT PRIMARY KEY, baseline_id TEXT NOT NULL "
        "REFERENCES baseline(baseline_id), payload TEXT NOT NULL)"
    ),
    (
        "CREATE TABLE read_record (read_record_id TEXT PRIMARY KEY, task_id TEXT NOT NULL "
        "REFERENCES task(task_id), response_json TEXT NOT NULL)"
    ),
)
# Upgrades are applied in ascending order inside one transaction, so a project written by an
# earlier build opens after being extended rather than being refused. A database written by a
# newer build is still refused: this build cannot know what that version means.
_MIGRATIONS: dict[int, tuple[str, ...]] = {
    2: (
        "CREATE TABLE author_decision (decision_id TEXT PRIMARY KEY, decision_key TEXT NOT NULL, "
        "project_id TEXT NOT NULL REFERENCES project(project_id), baseline_id TEXT REFERENCES "
        "baseline(baseline_id), supersedes TEXT, payload TEXT NOT NULL)",
        "CREATE INDEX author_decision_key ON author_decision(project_id, decision_key)",
    ),
}


def _upgrade_statements(from_version: int) -> Iterator[str]:
    """Yield the statements that bring a database from ``from_version`` to the current version."""
    for version in range(from_version + 1, _SCHEMA_VERSION + 1):
        yield from _MIGRATIONS[version]


def _migrate(connection: sqlite3.Connection, stored_version: int) -> None:
    """Upgrade an older project in place; refuse a version this build cannot interpret."""
    if not 1 <= stored_version <= _SCHEMA_VERSION:
        raise ProjectStoreError("Unsupported project storage version")
    connection.execute("BEGIN IMMEDIATE")
    # The version is read again once the write lock is held. A second opener can read the old
    # version before the first commits; it then waits here, and applying the same statements again
    # would fail on a table that now exists.
    locked_version = connection.execute("PRAGMA user_version").fetchone()[0]
    if locked_version == _SCHEMA_VERSION:
        connection.commit()
        return
    if locked_version != stored_version:
        raise ProjectStoreError("Unsupported project storage version")
    for statement in _upgrade_statements(stored_version):
        connection.execute(statement)
    connection.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
    connection.commit()


def create_database(database_path: Path, *, project_id: str, author_workspace_root: str) -> None:
    """Initialize a current-version project exclusively, preserving any existing database."""
    BaselineRequest(project_id, "local-operator", "initialization", None, "0" * 64)
    require_record_text(author_workspace_root, "author_workspace_root")
    with database_path.open("xb"):
        pass
    try:
        with connect_project(database_path, check_schema=False) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            for statement in (*_SCHEMA, *_upgrade_statements(1)):
                connection.execute(statement)
            connection.execute(
                "INSERT INTO project VALUES (?, ?, NULL, ?)",
                (project_id, author_workspace_root, utc_now_iso()),
            )
            connection.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
    except (OSError, ProjectStoreError):
        database_path.unlink(missing_ok=True)
        raise


@contextmanager
def connect_project(
    database_path: Path, *, check_schema: bool = True
) -> Iterator[sqlite3.Connection]:
    """Open an existing database and close it after the caller finishes its transaction."""
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(
            database_path.resolve().as_uri() + "?mode=rw",
            uri=True,
            timeout=_BUSY_TIMEOUT_MS / 1000,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
        if check_schema:
            stored_version = connection.execute("PRAGMA user_version").fetchone()[0]
            if stored_version != _SCHEMA_VERSION:
                _migrate(connection, stored_version)
        yield connection
    except sqlite3.Error as exc:
        raise ProjectStoreError(f"Project database operation failed: {exc}") from exc
    finally:
        if connection is not None:
            connection.close()


def inspect_identity(database_path: Path) -> JsonObject:
    """Inspect fixed project ownership through a consistent read-only SQLite snapshot.

    ``immutable=1`` is unsafe while another worker is committing a transaction: SQLite skips
    the normal journal/WAL visibility rules and can report a transient malformed image. A
    regular read-only connection preserves the no-write guarantee while allowing SQLite to
    coordinate with concurrent project writers.
    """
    connection: sqlite3.Connection | None = None
    try:
        connection = sqlite3.connect(
            database_path.resolve().as_uri() + "?mode=ro",
            uri=True,
            timeout=_BUSY_TIMEOUT_MS / 1000,
        )
        connection.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
        row = connection.execute("SELECT project_id,author_workspace_root FROM project").fetchone()
        if row is None:
            raise ProjectStoreError("Project identity is missing")
        return {"project_id": row[0], "author_workspace_root": row[1]}
    except sqlite3.Error as exc:
        raise ProjectStoreError(f"Cannot inspect project ownership: {exc}") from exc
    finally:
        if connection is not None:
            connection.close()


def project_info(connection: sqlite3.Connection) -> JsonObject:
    """Read the project's metadata and authoritative baseline pointer."""
    row = connection.execute("SELECT * FROM project").fetchone()
    if row is None:
        raise ProjectStoreError("Project metadata is missing")
    return dict(row)
