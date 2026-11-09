"""Retained journal worlds and project decisions in a local SQLite library."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import cast

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.filesystem import require_no_reparse_points
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.journals.store_bindings import (
    bind_project as bind_project_record,
)
from research_file_workbench.journals.store_bindings import (
    get_binding as get_binding_record,
)
from research_file_workbench.journals.store_bindings import (
    list_bindings as list_binding_records,
)
from research_file_workbench.journals.store_checks import (
    get_check as get_check_record,
)
from research_file_workbench.journals.store_checks import (
    list_checks as list_check_records,
)
from research_file_workbench.journals.store_checks import (
    list_dispositions as list_disposition_records,
)
from research_file_workbench.journals.store_checks import (
    record_disposition as record_disposition_record,
)
from research_file_workbench.journals.store_checks import (
    save_check as save_check_record,
)
from research_file_workbench.journals.store_records import (
    BindingConflictError,
    WorldStoreError,
    check_root,
)
from research_file_workbench.journals.store_worlds import (
    get_world as get_world_record,
)
from research_file_workbench.journals.store_worlds import (
    list_worlds as list_world_records,
)
from research_file_workbench.journals.store_worlds import (
    read_source as read_source_record,
)
from research_file_workbench.journals.store_worlds import (
    save_world as save_world_record,
)

DATABASE_NAME = "worlds.sqlite3"
__all__ = ["BindingConflictError", "DATABASE_NAME", "WorldStore", "WorldStoreError"]
_SCHEMA_VERSION = 1
_BUSY_TIMEOUT_SECONDS = 5
_SCHEMA = (
    "CREATE TABLE library (singleton INTEGER PRIMARY KEY CHECK(singleton=1), "
    "payload TEXT NOT NULL)",
    "CREATE TABLE source (source_id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, "
    "content BLOB NOT NULL)",
    "CREATE TABLE world (version_id TEXT PRIMARY KEY, journal_id TEXT NOT NULL, "
    "version_ordinal INTEGER NOT NULL, created_at TEXT NOT NULL, content_sha256 TEXT NOT NULL, "
    "payload TEXT NOT NULL, UNIQUE(journal_id,version_ordinal))",
    "CREATE TABLE world_source (version_id TEXT NOT NULL REFERENCES world(version_id), "
    "source_id TEXT NOT NULL REFERENCES source(source_id), PRIMARY KEY(version_id,source_id))",
    "CREATE TABLE binding (binding_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, "
    "world_version_id TEXT NOT NULL REFERENCES world(version_id), "
    "previous_binding_id TEXT REFERENCES binding(binding_id), content_sha256 TEXT NOT NULL, "
    "payload TEXT NOT NULL)",
    "CREATE TABLE project_binding (project_id TEXT PRIMARY KEY, "
    "binding_id TEXT NOT NULL REFERENCES binding(binding_id))",
    "CREATE TABLE check_record (check_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, "
    "binding_id TEXT NOT NULL REFERENCES binding(binding_id), "
    "world_version_id TEXT NOT NULL REFERENCES world(version_id), "
    "content_sha256 TEXT NOT NULL, payload TEXT NOT NULL)",
    "CREATE TABLE disposition (disposition_id TEXT PRIMARY KEY, "
    "check_id TEXT NOT NULL REFERENCES check_record(check_id), "
    "content_sha256 TEXT NOT NULL, payload TEXT NOT NULL)",
)


class WorldStore:
    """Own library connections and transaction lifetimes."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.database_path = root / DATABASE_NAME

    def protected_roots(self) -> tuple[Path, ...]:
        """Return the author workspaces this library must never write into."""
        return self._protected_roots()

    def validate_library(self) -> None:
        """Validate retained library paths, boundaries and schema."""
        with self._connection():
            pass

    @classmethod
    def create(cls, root: Path, protected_roots: tuple[Path, ...] = ()) -> WorldStore:
        """Initialize a new explicit library outside protected input directories."""
        check_root(root, protected_roots)
        store = cls(root)
        store._check_database_paths()
        for suffix in ("", "-journal", "-wal", "-shm"):
            if Path(str(store.database_path) + suffix).exists():
                raise FileExistsError(
                    f"Journal library storage already exists: {store.database_path}"
                )
        root.mkdir(parents=True, exist_ok=True)
        with store.database_path.open("xb"):
            pass
        identity: JsonObject = {
            "protected_roots": [path.resolve().as_posix() for path in protected_roots],
            "created_at": utc_now_iso(),
        }
        try:
            with store._connection(initializing=True) as connection, connection:
                connection.execute("BEGIN IMMEDIATE")
                for statement in _SCHEMA:
                    connection.execute(statement)
                connection.execute(
                    "INSERT INTO library VALUES (1,?)", (encode_json_object(identity),)
                )
                connection.execute(f"PRAGMA user_version={_SCHEMA_VERSION}")
        except (OSError, WorldStoreError):
            store.database_path.unlink(missing_ok=True)
            raise
        return store

    def _check_database_paths(self) -> None:
        require_no_reparse_points(self.root)
        for suffix in ("", "-journal", "-wal", "-shm"):
            path = Path(str(self.database_path) + suffix)
            require_no_reparse_points(path)
            if path.exists() and path.stat().st_nlink > 1:
                raise WorldStoreError("Writable journal library files must not have hard links")

    def _protected_roots(self) -> tuple[Path, ...]:
        connection = sqlite3.connect(self.database_path.resolve().as_uri() + "?mode=ro", uri=True)
        try:
            row = connection.execute("SELECT payload FROM library WHERE singleton=1").fetchone()
            if row is None:
                raise WorldStoreError("Journal library identity is missing")
            values = decode_json_object(row[0]).get("protected_roots")
            if not isinstance(values, list) or any(
                not isinstance(value, str) or not Path(value).is_absolute() for value in values
            ):
                raise WorldStoreError("Journal library protected roots are invalid")
            return tuple(Path(value) for value in cast(list[str], values))
        finally:
            connection.close()

    @contextmanager
    def _connection(self, *, initializing: bool = False) -> Iterator[sqlite3.Connection]:
        self._check_database_paths()
        if not self.database_path.is_file():
            raise WorldStoreError("Journal library does not exist; initialize it explicitly")
        connection: sqlite3.Connection | None = None
        try:
            if not initializing:
                check_root(self.root, self._protected_roots())
            connection = sqlite3.connect(
                self.database_path.resolve().as_uri() + "?mode=rw",
                uri=True,
                timeout=_BUSY_TIMEOUT_SECONDS,
            )
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            if (
                not initializing
                and connection.execute("PRAGMA user_version").fetchone()[0] != _SCHEMA_VERSION
            ):
                raise WorldStoreError("Unsupported journal library schema version")
            yield connection
        except sqlite3.Error as exc:
            raise WorldStoreError(f"Journal library operation failed: {exc}") from exc
        finally:
            if connection is not None:
                connection.close()

    def save_world(self, world: JsonObject, sources: dict[str, bytes]) -> JsonObject:
        """Atomically retain source bytes and an immutable world."""
        with self._connection() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            return save_world_record(connection, world, sources)

    def get_world(self, version_id: str) -> JsonObject:
        """Recover one exact world version and its assigned metadata."""
        with self._connection() as connection:
            return get_world_record(connection, version_id)

    def list_worlds(self) -> list[JsonObject]:
        """List immutable versions without selecting a project binding."""
        with self._connection() as connection:
            return list_world_records(connection)

    def read_source(self, source_id: str) -> bytes:
        """Recover source bytes after checking their content-addressed identity."""
        with self._connection() as connection:
            return read_source_record(connection, source_id)

    def bind_project(
        self,
        project_id: str,
        project_root: str,
        baseline_id: str,
        world_version_id: str,
        *,
        expected_binding_id: str | None,
        actor_id: str,
        surface: str,
    ) -> JsonObject:
        """Compare and switch a project's immutable world binding atomically."""
        with self._connection() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            return bind_project_record(
                connection,
                project_id,
                project_root,
                baseline_id,
                world_version_id,
                expected_binding_id=expected_binding_id,
                actor_id=actor_id,
                surface=surface,
            )

    def get_binding(self, project_id: str) -> JsonObject | None:
        """Return a project's explicitly selected current binding, if one exists."""
        with self._connection() as connection:
            return get_binding_record(connection, project_id)

    def list_bindings(self, project_id: str | None = None) -> list[JsonObject]:
        """List retained binding history, optionally limited to one project."""
        with self._connection() as connection:
            return list_binding_records(connection, project_id)

    def save_check(self, check: JsonObject) -> JsonObject:
        """Retain an immutable check while its exact project binding is current."""
        with self._connection() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            return save_check_record(connection, check)

    def get_check(self, check_id: str) -> JsonObject:
        """Return a retained check without rewriting its original conclusion."""
        with self._connection() as connection:
            return get_check_record(connection, check_id)

    def list_checks(
        self, project_id: str | None = None, *, binding_id: str | None = None
    ) -> list[JsonObject]:
        """List retained checks filtered by project and exact binding."""
        with self._connection() as connection:
            return list_check_records(connection, project_id, binding_id=binding_id)

    def record_disposition(
        self, check_id: str, rule_id: str, action: str, note: str, actor_id: str, *, surface: str
    ) -> JsonObject:
        """Append an operator note or deferral while preserving the original verdict."""
        with self._connection() as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            return record_disposition_record(
                connection, check_id, rule_id, action, note, actor_id, surface=surface
            )

    def list_dispositions(self, check_id: str) -> list[JsonObject]:
        """List chronological operator dispositions for one retained check."""
        with self._connection() as connection:
            return list_disposition_records(connection, check_id)
