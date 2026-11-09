"""Baseline history and idempotent management decisions within a caller-owned transaction."""

import sqlite3
import uuid
from collections.abc import Sequence

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.projects import artifact_records
from research_file_workbench.projects.artifact_records import read_artifact
from research_file_workbench.projects.models import (
    BaselineRequest,
    ProjectStoreError,
    require_record_text,
)
from research_file_workbench.projects.project_database import project_info

_BASELINE_SELECT = (
    "SELECT b.baseline_id,b.artifact_version_id,b.payload,a.sha256 AS artifact_sha256 "
    "FROM baseline b LEFT JOIN artifact a ON a.version_id=b.artifact_version_id"
)


def apply_baseline(
    connection: sqlite3.Connection,
    request: BaselineRequest,
    *,
    source_bytes: bytes | None,
    source_path: str,
    confirmation_reason: str,
    evidence: Sequence[JsonObject],
    reader_version: str,
) -> JsonObject:
    """Apply one replay-safe baseline decision on the caller's transaction."""
    project = project_info(connection)
    if request.project_id != project["project_id"]:
        raise ProjectStoreError("Request belongs to a different project")
    replay = lookup_request(
        connection, request.actor_id, request.request_id, request.request_digest
    )
    if replay is not None:
        return replay
    require_record_text(source_path, "source_path")
    require_record_text(confirmation_reason, "confirmation_reason")
    require_record_text(reader_version, "reader_version")
    now = utc_now_iso()
    previous = project["current_baseline_id"]
    result: JsonObject = {
        "request_id": request.request_id,
        "request_digest": request.request_digest,
        "status": "BASELINE_CONFLICT",
        "previous_baseline_id": previous,
        "result_baseline_id": None,
        "invalidated_refs": [],
        "created_at": now,
    }
    if previous == request.expected_baseline_id:
        baseline_id, invalidated = _commit_baseline(
            connection,
            request,
            source_bytes=source_bytes,
            source_path=source_path,
            confirmation_reason=confirmation_reason,
            evidence=evidence,
            reader_version=reader_version,
            previous=previous,
            now=now,
        )
        result.update(
            status="APPLIED", result_baseline_id=baseline_id, invalidated_refs=invalidated
        )
    save_request(connection, request, source_path, confirmation_reason, result)
    return result


def _commit_baseline(
    connection: sqlite3.Connection,
    request: BaselineRequest,
    *,
    source_bytes: bytes | None,
    source_path: str,
    confirmation_reason: str,
    evidence: Sequence[JsonObject],
    reader_version: str,
    previous: object,
    now: str,
) -> tuple[str, list[str]]:
    """Persist artifact, baseline, evidence and current pointer as one unit."""
    artifact_records.store_blob(
        connection, request.artifact_version_id, request.source_sha256, source_bytes
    )
    baseline_id = f"baseline-{uuid.uuid4().hex}"
    baseline: JsonObject = {
        "baseline_id": baseline_id,
        "project_id": request.project_id,
        "artifact_version_ids": [request.artifact_version_id],
        "author_decision_version_ids": [],
        "rule_bindings": [],
        "source_sha256": request.source_sha256,
        "reader_version": reader_version,
        "source_kind": "initial_import" if previous is None else "trusted_rebaseline",
        "source_path": source_path,
        "actor_id": request.actor_id,
        "confirmation_reason": confirmation_reason,
        "created_at": now,
    }
    connection.execute(
        "INSERT INTO baseline VALUES (?,?,?)",
        (baseline_id, request.artifact_version_id, encode_json_object(baseline)),
    )
    from research_file_workbench.projects import evidence_records

    evidence_records.store_evidence(
        connection, baseline_id, request.artifact_version_id, reader_version, evidence
    )
    invalidated = evidence_records.invalidated_refs(connection, baseline, reader_version)
    connection.execute(
        "UPDATE project SET current_baseline_id=? WHERE project_id=?",
        (baseline_id, request.project_id),
    )
    return baseline_id, invalidated


def lookup_request(
    connection: sqlite3.Connection, actor_id: str, request_id: str, request_digest: str
) -> JsonObject | None:
    """Return a saved request result or record a conflicting reuse of its identity."""
    row = connection.execute(
        (
            "SELECT request_digest, result_json FROM baseline_request WHERE "
            "actor_id=? AND request_id=?"
        ),
        (actor_id, request_id),
    ).fetchone()
    if row is None:
        return None
    original = decode_json_object(row["result_json"])
    if row["request_digest"] == request_digest:
        return original
    conflict: JsonObject = {
        "request_id": request_id,
        "request_digest": request_digest,
        "status": "IDEMPOTENCY_CONFLICT",
        "previous_baseline_id": None,
        "result_baseline_id": None,
        "invalidated_refs": [],
        "created_at": utc_now_iso(),
        "original_request_digest": row["request_digest"],
        "original_result_baseline_id": original.get("result_baseline_id"),
    }
    connection.execute(
        (
            "INSERT INTO "
            "request_conflict(actor_id,request_id,request_digest,result_json) VALUES "
            "(?,?,?,?)"
        ),
        (actor_id, request_id, request_digest, encode_json_object(conflict)),
    )
    return conflict


def record_rejection(
    connection: sqlite3.Connection,
    request: BaselineRequest,
    *,
    source_path: str,
    confirmation_reason: str,
    reason: str,
) -> JsonObject:
    """Persist a known input refusal; later retries cannot turn it into an applied request."""
    require_record_text(reason, "rejection reason")
    project = project_info(connection)
    if project["project_id"] != request.project_id:
        raise ProjectStoreError("Request belongs to a different project")
    replay = lookup_request(
        connection, request.actor_id, request.request_id, request.request_digest
    )
    if replay is not None:
        return replay
    result: JsonObject = {
        "request_id": request.request_id,
        "request_digest": request.request_digest,
        "status": "REJECTED",
        "previous_baseline_id": project["current_baseline_id"],
        "result_baseline_id": None,
        "invalidated_refs": [],
        "created_at": utc_now_iso(),
        "rejection_reason": reason,
    }
    save_request(connection, request, source_path, confirmation_reason, result)
    return result


def save_request(
    connection: sqlite3.Connection,
    request: BaselineRequest,
    source_path: str,
    confirmation_reason: str,
    result: JsonObject,
) -> None:
    """Persist one management request, its operator decision and terminal result together."""
    require_record_text(source_path, "source_path")
    require_record_text(confirmation_reason, "confirmation_reason")
    now = result["created_at"]
    request_record = {
        **request.payload(),
        "request_id": request.request_id,
        "request_digest": request.request_digest,
        "created_at": now,
    }
    decision: JsonObject = {
        "source": "local_operator",
        "actor_id": request.actor_id,
        "confirmed_at": now,
        "confirmation_reason": confirmation_reason,
        "source_path": source_path,
        "limitations": ["Local operator labels do not establish authenticated identity."],
    }
    connection.execute(
        "INSERT INTO baseline_request VALUES (?,?,?,?,?,?)",
        (
            request.actor_id,
            request.request_id,
            request.request_digest,
            encode_json_object(request_record),
            encode_json_object(decision),
            encode_json_object(result),
        ),
    )


def get_selected_baseline(
    connection: sqlite3.Connection, baseline_id: str | None = None
) -> JsonObject:
    """Return one historical baseline, defaulting to the current pointer."""
    if baseline_id is not None:
        return get_baseline(connection, baseline_id)
    identity = project_info(connection)["current_baseline_id"]
    if identity is None:
        raise ProjectStoreError("No current reading baseline has been selected")
    if (
        connection.execute("SELECT 1 FROM baseline WHERE baseline_id=?", (identity,)).fetchone()
        is None
    ):
        raise ProjectStoreError("Current baseline pointer references a missing baseline")
    return get_baseline(connection, identity)


def get_baseline(connection: sqlite3.Connection, baseline_id: object) -> JsonObject:
    """Load one exact retained baseline or refuse an unknown identity."""
    row = connection.execute(_BASELINE_SELECT + " WHERE b.baseline_id=?", (baseline_id,)).fetchone()
    if row is None:
        raise ProjectStoreError("Reading baseline does not exist")
    return _verified_baseline(connection, row)


def list_baselines(connection: sqlite3.Connection) -> list[JsonObject]:
    """Return immutable baseline history in insertion order."""
    return [
        _verified_baseline(connection, row)
        for row in connection.execute(_BASELINE_SELECT + " ORDER BY b.rowid")
    ]


def _verified_baseline(connection: sqlite3.Connection, row: sqlite3.Row) -> JsonObject:
    """Bind baseline JSON to its authoritative SQL identities and retained source bytes."""
    record = decode_json_object(row["payload"])
    if record.get("baseline_id") != row["baseline_id"]:
        raise ProjectStoreError("Stored baseline identity differs from its database record")
    if record.get("project_id") != project_info(connection)["project_id"]:
        raise ProjectStoreError("Stored baseline belongs to another project")
    if record.get("artifact_version_ids") != [row["artifact_version_id"]]:
        raise ProjectStoreError("Stored baseline artifact binding differs from its database record")
    if row["artifact_sha256"] is None:
        raise ProjectStoreError("Stored baseline references a missing artifact")
    if record.get("source_sha256") != row["artifact_sha256"]:
        raise ProjectStoreError("Stored baseline source hash differs from its retained artifact")
    read_artifact(connection, row["artifact_version_id"])
    return record


def get_request(connection: sqlite3.Connection, actor_id: str, request_id: str) -> JsonObject:
    """Return the original request, local decision, result, and conflicting attempts."""
    row = connection.execute(
        "SELECT * FROM baseline_request WHERE actor_id=? AND request_id=?",
        (actor_id, request_id),
    ).fetchone()
    if row is None:
        raise ProjectStoreError("Baseline request does not exist")
    conflicts = [
        decode_json_object(item["result_json"])
        for item in connection.execute(
            (
                "SELECT result_json FROM request_conflict WHERE actor_id=? AND "
                "request_id=? ORDER BY attempt_id"
            ),
            (actor_id, request_id),
        )
    ]
    return {
        "request": decode_json_object(row["request_json"]),
        "decision": decode_json_object(row["decision_json"]),
        "result": decode_json_object(row["result_json"]),
        "conflict_attempts": conflicts,
    }
