"""Core-derived format snapshots retained in the existing artifact/evidence store."""

import sqlite3
from typing import cast

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.projects.artifact_records import read_artifact, store_blob
from research_file_workbench.projects.baseline_records import get_baseline
from research_file_workbench.projects.evidence_records import store_evidence
from research_file_workbench.projects.models import ProjectStoreError

FORMAT_SNAPSHOT_METHOD = "docx_core_format_snapshot"
FORMAT_SNAPSHOT_METHOD_VERSION = "docx-core-format-snapshot-1.0.0"
TEMPLATE_FINDINGS_METHOD = "docx_template_comparison"
TEMPLATE_FINDINGS_METHOD_VERSION = "docx-template-comparison-1.0.0"


def save_format_snapshot(
    connection: sqlite3.Connection, baseline_id: str, snapshot: JsonObject
) -> JsonObject:
    baseline = get_baseline(connection, baseline_id)
    if baseline["source_sha256"] != snapshot["source_sha256"]:
        raise ProjectStoreError("Format snapshot differs from its baseline")
    content = encode_json_object(snapshot).encode()
    digest = sha256_bytes(content)
    artifact = f"artifact-version-{digest}"
    store_blob(connection, artifact, digest, content)
    identity = "docx-format-" + sha256_bytes(f"{FORMAT_SNAPSHOT_METHOD_VERSION}\0{digest}".encode())
    source_version = f"artifact-version-{baseline['source_sha256']}"
    engine = cast(JsonObject, snapshot["engine"])
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
            FORMAT_SNAPSHOT_METHOD_VERSION,
            artifact,
            f"{engine['name']}@{engine['version']}",
        ],
        "statement": "Core-derived effective document facts; not independent review.",
        "scope": {"object_type": "docx_format"},
        "extraction_method": FORMAT_SNAPSHOT_METHOD,
        "extraction_method_version": FORMAT_SNAPSHOT_METHOD_VERSION,
        "verification_record_ids": [],
        "snapshot_artifact_version_id": artifact,
        "source_sha256": snapshot["source_sha256"],
    }
    store_evidence(
        connection,
        baseline_id,
        source_version,
        FORMAT_SNAPSHOT_METHOD_VERSION,
        [record],
    )
    return {
        "baseline_id": baseline_id,
        "snapshot_id": identity,
        "source_sha256": snapshot["source_sha256"],
        "engine": snapshot["engine"],
    }


def get_format_snapshot(connection: sqlite3.Connection, baseline_id: str) -> JsonObject:
    baseline = get_baseline(connection, baseline_id)
    row = connection.execute(
        "SELECT e.payload FROM evidence e JOIN baseline_evidence b "
        "ON b.evidence_version=e.evidence_version WHERE b.baseline_id=? "
        "AND json_extract(e.payload,'$.scope.object_type')='docx_format' "
        "ORDER BY b.rowid DESC LIMIT 1",
        (baseline_id,),
    ).fetchone()
    if row is None:
        raise ValueError("Capture a core format snapshot for this baseline before comparing")
    record = decode_json_object(row["payload"])
    snapshot = decode_json_object(
        read_artifact(connection, str(record["snapshot_artifact_version_id"]))
    )
    if snapshot["source_sha256"] != baseline["source_sha256"]:
        raise ProjectStoreError("Retained format snapshot belongs to different baseline bytes")
    return snapshot


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
