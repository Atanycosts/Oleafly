from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import cast

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import JsonObject, encode_json_object
from research_file_workbench.projects import format_records
from research_file_workbench.projects.artifact_records import store_blob
from research_file_workbench.projects.models import BaselineRequest, ProjectStoreError
from research_file_workbench.projects.store import ProjectStore

PROJECT_ID = "project-format-record-tests"
ACTOR_ID = "operator-format-record-tests"
READER_VERSION = "python-docx-reader-unrelated"


@pytest.fixture
def store(tmp_path: Path) -> ProjectStore:
    author_workspace = tmp_path / "author"
    author_workspace.mkdir()
    database = tmp_path / "application" / "project.sqlite3"
    database.parent.mkdir()
    return ProjectStore.create(
        database,
        project_id=PROJECT_ID,
        author_workspace_root=author_workspace.resolve().as_posix(),
    )


def _apply(
    store: ProjectStore,
    content: bytes,
    *,
    request_id: str,
    expected_baseline_id: str | None = None,
) -> JsonObject:
    request = BaselineRequest(
        project_id=PROJECT_ID,
        actor_id=ACTOR_ID,
        request_id=request_id,
        expected_baseline_id=expected_baseline_id,
        source_sha256=sha256_bytes(content),
    )
    return store.apply_baseline(
        request,
        source_bytes=content,
        source_path=f"{request_id}.docx",
        confirmation_reason="Confirm this format-record fixture as a baseline.",
        evidence=[],
        reader_version=READER_VERSION,
    )


def _baseline_id(result: JsonObject) -> str:
    identity = result["result_baseline_id"]
    assert isinstance(identity, str)
    return identity


def _snapshot(content: bytes) -> JsonObject:
    return {
        "schema_version": 1,
        "source_sha256": sha256_bytes(content),
        "engine": {"name": "@docx-editor.dev/core", "version": "2.36.0"},
        "parts": [],
        "objects": [],
        "capabilities": {},
        "unsupported": [],
    }


def _by_scope(records: list[JsonObject], object_type: str) -> JsonObject:
    matches = [item for item in records if item.get("scope") == {"object_type": object_type}]
    assert len(matches) == 1
    return matches[0]


def test_format_evidence_uses_independent_methods_across_baseline_advancement(
    store: ProjectStore,
) -> None:
    first_content = b"first exact DOCX source"
    first_baseline = _baseline_id(_apply(store, first_content, request_id="format-first"))
    store.save_format_snapshot(first_baseline, _snapshot(first_content))
    store.save_template_findings(first_baseline, [{"case_id": "case-first"}])

    initial = store.list_evidence(first_baseline, reader_version="later-python-reader")
    snapshot_record = _by_scope(initial, "docx_format")
    findings_record = _by_scope(initial, "template_findings")

    assert snapshot_record["extraction_method_version"] == (
        format_records.FORMAT_SNAPSHOT_METHOD_VERSION
    )
    assert findings_record["extraction_method_version"] == (
        format_records.TEMPLATE_FINDINGS_METHOD_VERSION
    )
    assert all(item["applicability_to_current_baseline"] == "CURRENT" for item in initial)
    assert all(item["stale_reasons"] == [] for item in initial)

    second_content = b"second exact DOCX source"
    advanced = _apply(
        store,
        second_content,
        request_id="format-second",
        expected_baseline_id=first_baseline,
    )
    second_baseline = _baseline_id(advanced)
    old_ids = {
        cast(str, snapshot_record["evidence_version"]),
        cast(str, findings_record["evidence_version"]),
    }

    assert old_ids <= set(cast(list[str], advanced["invalidated_refs"]))
    historical = store.list_evidence(first_baseline, reader_version=READER_VERSION)
    assert all(item["applicability_to_current_baseline"] == "STALE" for item in historical)
    assert all(item["stale_reasons"] == ["source_version_changed"] for item in historical)

    store.save_format_snapshot(second_baseline, _snapshot(second_content))
    store.save_template_findings(second_baseline, [{"case_id": "case-second"}])
    current = store.list_evidence(reader_version="another-python-reader")
    assert len(current) == 2
    assert all(item["applicability_to_current_baseline"] == "CURRENT" for item in current)
    assert all(item["stale_reasons"] == [] for item in current)


def test_snapshot_identity_changes_with_format_method_version(
    store: ProjectStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    content = b"method-versioned format source"
    baseline_id = _baseline_id(_apply(store, content, request_id="format-method"))
    snapshot = _snapshot(content)

    first = store.save_format_snapshot(baseline_id, snapshot)
    repeated = store.save_format_snapshot(baseline_id, snapshot)
    assert repeated["snapshot_id"] == first["snapshot_id"]

    monkeypatch.setattr(
        format_records,
        "FORMAT_SNAPSHOT_METHOD_VERSION",
        "docx-core-format-snapshot-2.0.0",
    )
    corrected = store.save_format_snapshot(baseline_id, snapshot)
    records = store.list_evidence(baseline_id, reader_version=READER_VERSION)
    by_method = {cast(str, item["extraction_method_version"]): item for item in records}

    assert corrected["snapshot_id"] != first["snapshot_id"]
    assert (
        by_method[format_records.FORMAT_SNAPSHOT_METHOD_VERSION][
            "applicability_to_current_baseline"
        ]
        == "CURRENT"
    )
    assert (
        by_method["docx-core-format-snapshot-1.0.0"]["applicability_to_current_baseline"] == "STALE"
    )
    assert by_method["docx-core-format-snapshot-1.0.0"]["stale_reasons"] == [
        "reader_version_changed"
    ]


def _insert_legacy_findings(
    store: ProjectStore,
    baseline_id: str,
    *,
    scope: JsonObject,
    findings_artifact_version_id: str,
) -> str:
    evidence_id = "legacy-template-findings"
    baseline = store.get_baseline(baseline_id)
    source_version = f"artifact-version-{baseline['source_sha256']}"
    record: JsonObject = {
        "evidence_id": evidence_id,
        "evidence_version": evidence_id,
        "kind": "source_observation",
        "artifact_version_id": source_version,
        "object_locator": {"template_findings_id": evidence_id},
        "parse_status": "parsed",
        "limitations": [],
        "dependencies": [
            source_version,
            format_records.TEMPLATE_FINDINGS_METHOD_VERSION,
            findings_artifact_version_id,
        ],
        "statement": "Legacy template findings retained before method metadata was added.",
        "scope": scope,
        "extraction_method": format_records.TEMPLATE_FINDINGS_METHOD,
        "verification_record_ids": [],
        "findings_artifact_version_id": findings_artifact_version_id,
        "source_sha256": baseline["source_sha256"],
    }
    with sqlite3.connect(store.database_path) as connection:
        connection.execute(
            "INSERT INTO evidence VALUES (?,?,?)",
            (evidence_id, source_version, encode_json_object(record)),
        )
        connection.execute("INSERT INTO baseline_evidence VALUES (?,?)", (baseline_id, evidence_id))
    return evidence_id


def test_legacy_findings_need_exact_scope_and_a_valid_retained_artifact(
    store: ProjectStore,
) -> None:
    content = b"legacy findings source"
    baseline_id = _baseline_id(_apply(store, content, request_id="legacy-findings"))
    artifact_content = encode_json_object({"findings": []}).encode()
    digest = sha256_bytes(artifact_content)
    artifact_id = f"artifact-version-{digest}"
    with sqlite3.connect(store.database_path) as connection:
        store_blob(connection, artifact_id, digest, artifact_content)

    evidence_id = _insert_legacy_findings(
        store,
        baseline_id,
        scope={"object_type": "template_findings"},
        findings_artifact_version_id=artifact_id,
    )
    initial = store.list_evidence(baseline_id, reader_version=READER_VERSION)

    assert len(initial) == 1
    assert initial[0]["evidence_version"] == evidence_id
    assert initial[0]["applicability_to_current_baseline"] == "CURRENT"
    assert initial[0]["stale_reasons"] == []

    advanced = _apply(
        store,
        b"advanced legacy findings source",
        request_id="legacy-findings-advanced",
        expected_baseline_id=baseline_id,
    )
    assert evidence_id in cast(list[str], advanced["invalidated_refs"])
    historical = store.list_evidence(baseline_id, reader_version=READER_VERSION)
    assert historical[0]["stale_reasons"] == ["source_version_changed"]


@pytest.mark.parametrize(
    ("scope", "artifact_id"),
    [
        ({"object_type": "other"}, "artifact-version-" + "0" * 64),
        ({"object_type": "template_findings"}, "artifact-version-" + "0" * 64),
    ],
)
def test_legacy_findings_compatibility_stays_bounded(
    store: ProjectStore, scope: JsonObject, artifact_id: str
) -> None:
    baseline_id = _baseline_id(_apply(store, b"bounded legacy source", request_id="legacy-bounded"))
    _insert_legacy_findings(
        store,
        baseline_id,
        scope=scope,
        findings_artifact_version_id=artifact_id,
    )

    with pytest.raises(ProjectStoreError):
        store.list_evidence(baseline_id, reader_version=READER_VERSION)
