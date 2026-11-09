"""Content-addressed artifact persistence and integrity checks."""

import sqlite3

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.projects.models import ProjectStoreError


def store_blob(
    connection: sqlite3.Connection, version_id: str, digest: str, content: bytes | None
) -> None:
    """Store content addressed by its digest, refusing conflicting bytes or identities."""
    if version_id != f"artifact-version-{digest}":
        raise ProjectStoreError("Artifact version and content digest disagree")
    row = connection.execute("SELECT 1 FROM artifact WHERE version_id=?", (version_id,)).fetchone()
    if content is not None and (not isinstance(content, bytes) or sha256_bytes(content) != digest):
        raise ProjectStoreError("Source bytes do not match the requested SHA-256")
    if row is not None:
        existing = read_artifact(connection, version_id)
        if content is not None and existing != content:
            raise ProjectStoreError("Stored source bytes conflict with their immutable version")
    elif content is None:
        raise ProjectStoreError("Source bytes are required for a new artifact version")
    else:
        connection.execute(
            "INSERT INTO artifact VALUES (?,?,?)",
            (version_id, digest, content),
        )


def read_artifact(connection: sqlite3.Connection, version_id: str) -> bytes:
    """Read retained bytes only after verifying their stored version hash."""
    row = connection.execute(
        "SELECT sha256,content FROM artifact WHERE version_id=?", (version_id,)
    ).fetchone()
    if row is None:
        raise ProjectStoreError("Artifact version does not exist")
    content = bytes(row["content"])
    if sha256_bytes(content) != row["sha256"] or version_id != f"artifact-version-{row['sha256']}":
        raise ProjectStoreError("Stored artifact content does not match its immutable version")
    return content
