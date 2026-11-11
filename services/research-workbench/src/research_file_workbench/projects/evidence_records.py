"""Immutable observations, render registrations and present applicability."""

import sqlite3
from collections.abc import Sequence
from typing import cast

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.hashing import sha256_text
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.projects.artifact_records import store_blob
from research_file_workbench.projects.baseline_records import get_baseline
from research_file_workbench.projects.models import ProjectStoreError, require_record_text
from research_file_workbench.projects.project_database import project_info


def store_evidence(
    connection: sqlite3.Connection,
    baseline_id: str,
    version_id: str,
    reader_version: str,
    evidence: Sequence[JsonObject],
) -> None:
    """Insert immutable observations and their baseline links in the active transaction."""
    for item in evidence:
        evidence_version = require_record_text(item.get("evidence_version"), "evidence_version")
        required = {
            "evidence_id",
            "kind",
            "artifact_version_id",
            "object_locator",
            "parse_status",
            "limitations",
            "dependencies",
            "statement",
            "scope",
            "extraction_method",
            "extraction_method_version",
            "verification_record_ids",
        }
        if not required.issubset(item):
            raise ProjectStoreError("Evidence is missing required fields")
        for name in ("evidence_id", "statement", "extraction_method"):
            require_record_text(item[name], name)
        if not isinstance(item["object_locator"], dict) or not isinstance(item["scope"], dict):
            raise ProjectStoreError("Evidence requires structured locators and scope")
        if item["parse_status"] not in (
            "parsed",
            "partial",
            "unsupported",
            "failed",
            "unverified",
        ):
            raise ProjectStoreError("Evidence parse status is invalid")
        for name in ("limitations", "dependencies"):
            values = item[name]
            if not isinstance(values, list) or any(
                not isinstance(value, str) or not value.strip() for value in values
            ):
                raise ProjectStoreError(f"Evidence {name} must contain nonblank strings")
        if not {version_id, reader_version}.issubset(cast(list[str], item["dependencies"])):
            raise ProjectStoreError("Evidence dependencies must include its source and reader")
        if (
            item["kind"] not in {"source_observation", "derived_render"}
            or item["verification_record_ids"] != []
        ):
            raise ProjectStoreError("Only unreviewed source observations and renders are supported")
        if (
            item["artifact_version_id"] != version_id
            or item["extraction_method_version"] != reader_version
        ):
            raise ProjectStoreError("Evidence source or reader version does not match the baseline")
        payload = encode_json_object(item)
        row = connection.execute(
            "SELECT payload FROM evidence WHERE evidence_version=?", (evidence_version,)
        ).fetchone()
        if row is None:
            connection.execute(
                "INSERT INTO evidence VALUES (?,?,?)", (evidence_version, version_id, payload)
            )
        elif row["payload"] != payload:
            raise ProjectStoreError("Evidence version already identifies different content")
        connection.execute(
            "INSERT INTO baseline_evidence VALUES (?,?)", (baseline_id, evidence_version)
        )


def invalidated_refs(
    connection: sqlite3.Connection, baseline: JsonObject, reader_version: str
) -> list[str]:
    """Identify evidence inapplicable to the proposed baseline using listing semantics."""
    return [
        cast(str, item["evidence_version"])
        for row in connection.execute("SELECT payload FROM evidence")
        if _stale_reasons(
            connection, item := decode_json_object(row["payload"]), baseline, reader_version
        )
    ]


def _stale_reasons(
    connection: sqlite3.Connection,
    item: JsonObject,
    current_baseline: JsonObject,
    reader_version: str,
) -> list[str]:
    reasons = []
    if item["artifact_version_id"] not in cast(list[str], current_baseline["artifact_version_ids"]):
        reasons.append("source_version_changed")
    if item["extraction_method_version"] != reader_version:
        reasons.append("reader_version_changed")
    scope = item.get("scope")
    if scope in ({"object_type": "render_bundle"}, {"object_type": "derived_render"}):
        from research_file_workbench.docx.page_mapping import PAGE_MAPPING_VERSION
        from research_file_workbench.projects.render_validation import SUPPORTED_BUNDLE_VERSIONS

        stored_record = item.get("value")
        if not isinstance(stored_record, dict):
            raise ProjectStoreError("Render bundle registration is missing its record")
        bound_baseline = require_record_text(stored_record.get("baseline_id"), "baseline_id")
        record = get_render_bundle(
            connection, bound_baseline, require_record_text(item["evidence_version"], "bundle_id")
        )
        manifest = cast(JsonObject, record["manifest"])
        if bound_baseline != current_baseline["baseline_id"]:
            reasons.append("baseline_binding_changed")
        if manifest.get("version") not in SUPPORTED_BUNDLE_VERSIONS:
            reasons.append("bundle_method_changed")
        if scope == {"object_type": "render_bundle"} and (
            manifest.get("mapping_version") != PAGE_MAPPING_VERSION
        ):
            reasons.append("mapping_method_changed")
    return reasons


def save_render_bundle(
    connection: sqlite3.Connection,
    *,
    baseline_id: str,
    manifest: JsonObject,
    blobs: dict[str, bytes],
    actor_id: str,
    confirmation_reason: str,
) -> JsonObject:
    """Commit captured render artifacts and their immutable evidence registration together."""
    require_record_text(actor_id, "actor_id")
    require_record_text(confirmation_reason, "confirmation_reason")
    digest = sha256_text(encode_json_object(manifest))
    bundle_id = f"render-bundle-{digest}"
    baseline = get_baseline(connection, baseline_id)
    if (
        manifest.get("baseline_id") != baseline_id
        or manifest.get("source_sha256") != baseline["source_sha256"]
    ):
        raise ProjectStoreError("Render bundle belongs to another source or baseline")
    reader_version = require_record_text(manifest.get("reader_version"), "reader_version")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise ProjectStoreError("Render bundle must retain its artifact references")
    registered: set[str] = set()
    for raw in artifacts:
        if not isinstance(raw, dict):
            raise ProjectStoreError("Render artifact reference is invalid")
        version = require_record_text(raw.get("version_id"), "version_id")
        content_hash = require_record_text(raw.get("sha256"), "sha256")
        if version not in blobs:
            raise ProjectStoreError("Render artifact content is missing")
        store_blob(connection, version, content_hash, blobs[version])
        registered.add(version)
    if registered != set(blobs):
        raise ProjectStoreError("Render bundle includes unreferenced content")
    existing = connection.execute(
        "SELECT payload FROM evidence WHERE evidence_version=?", (bundle_id,)
    ).fetchone()
    if existing is not None:
        return get_render_bundle(connection, baseline_id, bundle_id)
    record: JsonObject = {
        "bundle_id": bundle_id,
        "baseline_id": baseline_id,
        "manifest": manifest,
        "registered_at": utc_now_iso(),
        "actor_id": actor_id,
        "confirmation_reason": confirmation_reason,
    }
    version_id = f"artifact-version-{baseline['source_sha256']}"
    derived = manifest.get("evidence_kind") == "derived_pdf"
    evidence: JsonObject = {
        "evidence_id": f"evidence-{digest}",
        "evidence_version": bundle_id,
        "kind": "derived_render" if derived else "source_observation",
        "artifact_version_id": version_id,
        "object_locator": {"render_bundle_id": bundle_id},
        "parse_status": "partial",
        "limitations": manifest.get("limitations", []),
        "dependencies": [
            version_id,
            reader_version,
            require_record_text(manifest.get("version"), "bundle method"),
            require_record_text(manifest.get("mapping_version"), "mapping method"),
            *sorted(registered),
        ],
        "statement": (
            "Retained derived PDF from an explicit LibreOffice headless render; "
            "not independent visual or page-mapping verification."
            if derived
            else "Registered render and mapping evidence; not semantic verification."
        ),
        "scope": {"object_type": "derived_render" if derived else "render_bundle"},
        "extraction_method": (
            "libreoffice_headless_render" if derived else "render_bundle_registration"
        ),
        "extraction_method_version": reader_version,
        "verification_record_ids": [],
        "content_hash": sha256_text(encode_json_object(record)),
        "value": record,
    }
    store_evidence(connection, baseline_id, version_id, reader_version, [evidence])
    return record


def get_render_bundle(
    connection: sqlite3.Connection, baseline_id: str, bundle_id: str
) -> JsonObject:
    """Recover and integrity-check the exact bundle registered on one baseline."""
    row = connection.execute(
        "SELECT e.payload FROM evidence e JOIN baseline_evidence b "
        "ON b.evidence_version=e.evidence_version "
        "WHERE b.baseline_id=? AND e.evidence_version=?",
        (baseline_id, bundle_id),
    ).fetchone()
    if row is None:
        raise ProjectStoreError("Render bundle is not registered for this baseline")
    evidence = decode_json_object(row["payload"])
    record = evidence.get("value")
    if evidence.get("scope") not in (
        {"object_type": "render_bundle"},
        {"object_type": "derived_render"},
    ) or not isinstance(record, dict):
        raise ProjectStoreError("Requested evidence is not a render registration")
    record = cast(JsonObject, record)
    manifest = record.get("manifest")
    if (
        not isinstance(manifest, dict)
        or record.get("baseline_id") != baseline_id
        or record.get("bundle_id") != bundle_id
        or f"render-bundle-{sha256_text(encode_json_object(cast(JsonObject, manifest)))}"
        != bundle_id
        or evidence.get("content_hash") != sha256_text(encode_json_object(record))
    ):
        raise ProjectStoreError("Stored render bundle content or binding changed")
    return record


def list_render_bundles(
    connection: sqlite3.Connection, baseline_id: str | None = None
) -> list[JsonObject]:
    """List registrations for the requested or current baseline without marking them read."""
    identity = (
        baseline_id if baseline_id is not None else project_info(connection)["current_baseline_id"]
    )
    if identity is None:
        return []
    get_baseline(connection, identity)
    return _list_render_records(connection, cast(str, identity), "render_bundle")


def list_derived_renders(connection: sqlite3.Connection, baseline_id: str) -> list[JsonObject]:
    """List derived PDFs for one explicit baseline without mixing page bundles."""
    get_baseline(connection, baseline_id)
    return _list_render_records(connection, baseline_id, "derived_render")


def _list_render_records(
    connection: sqlite3.Connection, baseline_id: str, scope: str
) -> list[JsonObject]:
    rows = connection.execute(
        "SELECT e.evidence_version FROM evidence e JOIN baseline_evidence b "
        "ON b.evidence_version=e.evidence_version WHERE b.baseline_id=? "
        "AND json_extract(e.payload,'$.scope.object_type')=? "
        "ORDER BY b.rowid",
        (baseline_id, scope),
    ).fetchall()
    return [get_render_bundle(connection, baseline_id, row[0]) for row in rows]


def list_evidence(
    connection: sqlite3.Connection, baseline_id: str | None = None, *, reader_version: str
) -> list[JsonObject]:
    """Derive present applicability without overwriting historical evidence or verdicts."""
    current_id = project_info(connection)["current_baseline_id"]
    if current_id is None:
        if baseline_id is not None:
            raise ProjectStoreError("Reading baseline does not exist")
        return []
    current = get_baseline(connection, current_id)
    identity = baseline_id if baseline_id is not None else current_id
    get_baseline(connection, identity)
    items: list[JsonObject] = []
    for row in connection.execute(
        (
            "SELECT e.payload FROM evidence e JOIN baseline_evidence b ON "
            "e.evidence_version=b.evidence_version WHERE b.baseline_id=? ORDER BY "
            "b.rowid"
        ),
        (identity,),
    ):
        item = decode_json_object(row["payload"])
        reasons = _stale_reasons(connection, item, current, reader_version)
        item.update(
            baseline_is_current=identity == current_id,
            applicability_to_current_baseline="STALE" if reasons else "CURRENT",
            stale_reasons=reasons,
            verification_status="NOT_REVIEWED",
        )
        items.append(item)
    return items
