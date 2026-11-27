"""Core-derived format snapshots retained in the existing artifact/evidence store."""

import re
import sqlite3
from typing import TypedDict, cast

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.docx.format_snapshot import (
    FORMAT_SNAPSHOT_METHOD_VERSION as FORMAT_SNAPSHOT_METHOD_VERSION,
)
from research_file_workbench.docx.format_snapshot import format_snapshot_method
from research_file_workbench.projects.artifact_records import read_artifact, store_blob
from research_file_workbench.projects.baseline_records import get_baseline
from research_file_workbench.projects.evidence_records import store_evidence
from research_file_workbench.projects.models import ProjectStoreError

FORMAT_SNAPSHOT_METHOD = "docx_core_format_snapshot"
TEMPLATE_FINDINGS_METHOD = "docx_template_comparison"
TEMPLATE_FINDINGS_METHOD_VERSION = "docx-template-comparison-1.1.0"
LEGACY_TEMPLATE_FINDINGS_METHOD_VERSION = "docx-template-comparison-1.0.0"


class FormatSnapshotReference(TypedDict):
    """Exact evidence-bound identity of one retained format snapshot."""

    baseline_id: str
    source_sha256: str
    snapshot_artifact_version_id: str
    method_version: str


def _format_snapshot_reference(
    record: JsonObject, baseline_id: str, source_sha256: str
) -> FormatSnapshotReference:
    """Bind one format-evidence payload to the exact baseline source identity."""
    method = record.get("extraction_method_version")
    artifact = record.get("snapshot_artifact_version_id")
    artifact_digest = (
        artifact.removeprefix("artifact-version-")
        if isinstance(artifact, str) and artifact.startswith("artifact-version-")
        else None
    )
    if (
        record.get("scope") != {"object_type": "docx_format"}
        or record.get("extraction_method") != FORMAT_SNAPSHOT_METHOD
        or not isinstance(method, str)
        or not method.strip()
        or not isinstance(artifact, str)
        or artifact_digest is None
        or re.fullmatch(r"[0-9a-f]{64}", artifact_digest) is None
        or record.get("artifact_version_id") != f"artifact-version-{source_sha256}"
        or record.get("source_sha256") != source_sha256
    ):
        raise ProjectStoreError("Stored format snapshot evidence is invalid")
    return {
        "baseline_id": baseline_id,
        "source_sha256": source_sha256,
        "snapshot_artifact_version_id": artifact,
        "method_version": method,
    }


def _find_format_snapshot_reference(
    connection: sqlite3.Connection,
    baseline_id: str,
    *,
    method_version: str | None = None,
    artifact_version_id: str | None = None,
) -> FormatSnapshotReference | None:
    """Select the newest exact format registration linked to one baseline."""
    source_sha256 = cast(str, get_baseline(connection, baseline_id)["source_sha256"])
    filters = [
        "json_extract(e.payload,'$.scope.object_type')=?",
        "json_extract(e.payload,'$.extraction_method')=?",
    ]
    parameters: list[object] = [
        baseline_id,
        "docx_format",
        FORMAT_SNAPSHOT_METHOD,
    ]
    if method_version is not None:
        filters.append("json_extract(e.payload,'$.extraction_method_version')=?")
        parameters.append(method_version)
    if artifact_version_id is not None:
        filters.append("json_extract(e.payload,'$.snapshot_artifact_version_id')=?")
        parameters.append(artifact_version_id)
    row = connection.execute(
        "SELECT e.payload FROM evidence e JOIN baseline_evidence b "
        "ON b.evidence_version=e.evidence_version WHERE b.baseline_id=? AND "
        + " AND ".join(filters)
        + " ORDER BY b.rowid DESC LIMIT 1",
        parameters,
    ).fetchone()
    if row is None:
        return None
    return _format_snapshot_reference(
        decode_json_object(row["payload"]), baseline_id, source_sha256
    )


def _store_format_snapshot_evidence(
    connection: sqlite3.Connection,
    baseline_id: str,
    source_sha256: str,
    method: str,
    artifact_version_id: str,
    engine: JsonObject,
) -> str:
    """Register one already content-addressed snapshot against a baseline."""
    digest = artifact_version_id.removeprefix("artifact-version-")
    identity = "docx-format-" + sha256_bytes(f"{method}\0{digest}".encode())
    source_version = f"artifact-version-{source_sha256}"
    record: JsonObject = {
        "evidence_id": identity,
        "evidence_version": identity,
        "kind": "source_observation",
        "artifact_version_id": source_version,
        "object_locator": {"format_snapshot_id": identity},
        "parse_status": "parsed",
        "limitations": [],
        "dependencies": [
            source_version,
            method,
            artifact_version_id,
            f"{engine['name']}@{engine['version']}",
        ],
        "statement": "Core-derived effective document facts; not independent review.",
        "scope": {"object_type": "docx_format"},
        "extraction_method": FORMAT_SNAPSHOT_METHOD,
        "extraction_method_version": method,
        "verification_record_ids": [],
        "snapshot_artifact_version_id": artifact_version_id,
        "source_sha256": source_sha256,
    }
    store_evidence(connection, baseline_id, source_version, method, [record])
    return identity


def save_format_snapshot(
    connection: sqlite3.Connection, baseline_id: str, snapshot: JsonObject
) -> JsonObject:
    baseline = get_baseline(connection, baseline_id)
    if baseline["source_sha256"] != snapshot["source_sha256"]:
        raise ProjectStoreError("Format snapshot differs from its baseline")
    content = encode_json_object(snapshot).encode()
    method = format_snapshot_method(snapshot)
    digest = sha256_bytes(content)
    artifact = f"artifact-version-{digest}"
    store_blob(connection, artifact, digest, content)
    engine = cast(JsonObject, snapshot["engine"])
    identity = _store_format_snapshot_evidence(
        connection,
        baseline_id,
        cast(str, baseline["source_sha256"]),
        method,
        artifact,
        engine,
    )
    return {
        "baseline_id": baseline_id,
        "snapshot_id": identity,
        "source_sha256": snapshot["source_sha256"],
        "engine": snapshot["engine"],
        "method_version": method,
        "snapshot_artifact_version_id": artifact,
    }


def find_format_snapshot_reference(
    connection: sqlite3.Connection,
    baseline_id: str,
    *,
    method_version: str | None = None,
) -> FormatSnapshotReference | None:
    """Find the newest format registration without reading its snapshot blob."""
    return _find_format_snapshot_reference(connection, baseline_id, method_version=method_version)


def get_format_snapshot(
    connection: sqlite3.Connection,
    baseline_id: str,
    *,
    method_version: str | None = None,
    reference: FormatSnapshotReference | None = None,
) -> JsonObject:
    if reference is not None:
        if method_version is not None and method_version != reference["method_version"]:
            raise ValueError("Format snapshot method and reference disagree")
        selected = _find_format_snapshot_reference(
            connection,
            baseline_id,
            method_version=reference["method_version"],
            artifact_version_id=reference["snapshot_artifact_version_id"],
        )
        if selected is None or selected != reference:
            raise ValueError("Format snapshot reference is not registered for this baseline")
    else:
        selected = _find_format_snapshot_reference(
            connection, baseline_id, method_version=method_version
        )
        if selected is None:
            raise ValueError("Capture a core format snapshot for this baseline before comparing")
    snapshot = decode_json_object(
        read_artifact(connection, selected["snapshot_artifact_version_id"])
    )
    if format_snapshot_method(snapshot) != selected["method_version"]:
        raise ProjectStoreError("Retained format snapshot method differs from its registration")
    if snapshot.get("source_sha256") != selected["source_sha256"]:
        raise ProjectStoreError("Retained format snapshot belongs to different baseline bytes")
    return snapshot


def read_format_snapshot_artifact(
    connection: sqlite3.Connection, reference: FormatSnapshotReference
) -> bytes:
    """Read the exact registered snapshot bytes after checking link and content identity."""
    selected = _find_format_snapshot_reference(
        connection,
        reference["baseline_id"],
        method_version=reference["method_version"],
        artifact_version_id=reference["snapshot_artifact_version_id"],
    )
    if selected is None or selected != reference:
        raise ValueError("Format snapshot reference is not registered for this baseline")
    return read_artifact(connection, reference["snapshot_artifact_version_id"])


def copy_format_snapshot(
    connection: sqlite3.Connection,
    baseline_id: str,
    reference: FormatSnapshotReference,
    artifact_bytes: bytes,
) -> FormatSnapshotReference:
    """Register explicitly verified snapshot bytes for another exact source baseline."""
    source_sha256 = cast(str, get_baseline(connection, baseline_id)["source_sha256"])
    if source_sha256 != reference["source_sha256"]:
        raise ValueError("Format snapshot source does not match the target baseline")
    digest = sha256_bytes(artifact_bytes)
    artifact = f"artifact-version-{digest}"
    if artifact != reference["snapshot_artifact_version_id"]:
        raise ProjectStoreError("Format snapshot bytes do not match the referenced artifact")
    snapshot = decode_json_object(artifact_bytes)
    method = format_snapshot_method(snapshot)
    if (
        method != reference["method_version"]
        or snapshot.get("source_sha256") != reference["source_sha256"]
    ):
        raise ProjectStoreError(
            "Format snapshot bytes do not match the referenced source and method"
        )
    store_blob(connection, artifact, digest, artifact_bytes)
    _store_format_snapshot_evidence(
        connection,
        baseline_id,
        source_sha256,
        method,
        artifact,
        cast(JsonObject, snapshot["engine"]),
    )
    return {
        "baseline_id": baseline_id,
        "source_sha256": source_sha256,
        "snapshot_artifact_version_id": artifact,
        "method_version": method,
    }


def save_template_findings(
    connection: sqlite3.Connection, baseline_id: str, findings: list[JsonObject]
) -> str:
    """Retain a comparison result once; checks and pages refer to its content address."""
    baseline = get_baseline(connection, baseline_id)
    content = encode_json_object({"findings": findings}).encode()
    digest = sha256_bytes(content)
    artifact = f"artifact-version-{digest}"
    store_blob(connection, artifact, digest, content)
    source_version = f"artifact-version-{baseline['source_sha256']}"
    identity = "template-findings-" + sha256_bytes(
        (f"{TEMPLATE_FINDINGS_METHOD_VERSION}\0{baseline['source_sha256']}\0{digest}").encode()
    )
    record: JsonObject = {
        "evidence_id": identity,
        "evidence_version": identity,
        "kind": "source_observation",
        "artifact_version_id": source_version,
        "object_locator": {"template_findings_id": identity},
        "parse_status": "parsed",
        "limitations": [],
        "dependencies": [
            source_version,
            TEMPLATE_FINDINGS_METHOD_VERSION,
            artifact,
        ],
        "statement": (
            "Core-derived template comparison findings; not normative journal requirements."
        ),
        "scope": {"object_type": "template_findings"},
        "extraction_method": TEMPLATE_FINDINGS_METHOD,
        "extraction_method_version": TEMPLATE_FINDINGS_METHOD_VERSION,
        "verification_record_ids": [],
        "findings_artifact_version_id": artifact,
        "source_sha256": baseline["source_sha256"],
    }
    store_evidence(
        connection,
        baseline_id,
        source_version,
        TEMPLATE_FINDINGS_METHOD_VERSION,
        [record],
    )
    return artifact
