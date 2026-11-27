"""Real HTTP regressions for candidate checks pinned to retained format snapshots."""

from __future__ import annotations

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.docx.format_snapshot import FORMAT_SNAPSHOT_METHOD_VERSION
from research_file_workbench.workbench import template_service
from research_file_workbench.workbench.service import WorkbenchService
from tests.journals.test_analysis import template_bytes
from tests.workbench.test_template_service import (
    adopt_payload,
    post,
    snapshot,
    upload,
)

_REFERENCE_FIELDS = (
    "baseline_id",
    "source_sha256",
    "snapshot_artifact_version_id",
    "method_version",
)
_UPLOAD_RECEIPT_FIELDS = {*_REFERENCE_FIELDS, "snapshot_id", "engine"}


def _reference(receipt):
    assert set(receipt) == _UPLOAD_RECEIPT_FIELDS
    reference = {field: receipt[field] for field in _REFERENCE_FIELDS}
    assert set(reference) == set(_REFERENCE_FIELDS)
    return reference


def _copied_reference(receipt):
    assert set(receipt) == set(_REFERENCE_FIELDS)
    return {field: receipt[field] for field in _REFERENCE_FIELDS}


def _candidate_context(server, *, template_facts=None):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, world = post(
        server,
        "/api/template-world",
        {**adopt_payload(content), "snapshot": template_facts or snapshot(content)},
    )
    assert status == 200, world
    status, project = post(
        server,
        "/api/projects",
        {"name": "Candidate snapshot flow", **upload(content, "candidate.docx")},
    )
    assert status == 200, project
    status, receipt = post(
        server,
        "/api/docx-format",
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "snapshot": snapshot(content, size=12),
        },
    )
    assert status == 200, receipt
    reference = _reference(receipt)
    status, prepared = post(
        server,
        "/api/template-prepare",
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "world_version_id": world["version_id"],
            "surface": "agent",
            "include_snapshot_reference": True,
        },
    )
    assert status == 200, prepared
    assert prepared["snapshot_reference"] == reference
    assert set(prepared["snapshot_reference"]) == set(_REFERENCE_FIELDS)
    return content, world, project, reference


def _table_header_snapshot(content):
    facts = snapshot(content)
    table_path = [0, 10, 0]
    table_id = "/word/document.xml#" + ".".join(map(str, table_path))
    facts["objects"].extend(
        [
            {
                "object_id": table_id,
                "part": "/word/document.xml",
                "path": table_path,
                "kind": "table",
                "role": "table",
                "role_basis": [],
                "text": "",
                "properties": {"table": {"columnWidthsPt": [100, 100]}},
                "declared": {},
                "evidence": {"top_level_body": True},
            },
            {
                "object_id": table_id + ".0",
                "part": "/word/document.xml",
                "path": [*table_path, 0],
                "kind": "tr",
                "role": "unknown",
                "role_basis": [],
                "text": "",
                "properties": {"row": {"isHeader": True}},
                "declared": {},
                "evidence": {},
                "table_context": {
                    "table_object_id": table_id,
                    "row_index": 0,
                    "row_count": 2,
                    "conditions": ["firstRow"],
                },
            },
            {
                "object_id": table_id + ".1",
                "part": "/word/document.xml",
                "path": [*table_path, 1],
                "kind": "tr",
                "role": "unknown",
                "role_basis": [],
                "text": "",
                "properties": {"row": {"isHeader": False}},
                "declared": {},
                "evidence": {},
                "table_context": {
                    "table_object_id": table_id,
                    "row_index": 1,
                    "row_count": 2,
                    "conditions": [],
                },
            },
        ]
    )
    return facts, table_id


def _candidate_payload(project, world, reference, request_id, *, baseline_id=None):
    return {
        "project_id": project["project_id"],
        "expected_baseline_id": baseline_id or project["baseline_id"],
        "world_version_id": world["version_id"],
        "expected_binding_id": None,
        "request_id": request_id,
        "origin": {"surface": "agent"},
        "response": "candidate",
        "snapshot_reference": reference,
    }


def test_candidate_review_defers_groups_and_keeps_its_pinned_snapshot(running_server, monkeypatch):
    content, world, project, reference = _candidate_context(running_server)
    original_build = template_service.build_finding_query_view
    built_roles = []

    def counted_build(check, snapshot_value, findings):
        built_roles.append(snapshot_value["objects"][0]["role"])
        return original_build(check, snapshot_value, findings)

    monkeypatch.setattr(template_service, "build_finding_query_view", counted_build)
    status, candidate = post(
        running_server,
        "/api/template-check",
        _candidate_payload(project, world, reference, "candidate-pinned-review"),
    )
    assert status == 200, candidate
    assert "groups" not in candidate
    assert set(candidate["template_comparison"]) == {"total", "finding_summary"}
    assert built_roles == []

    stored = running_server.service.store.get_check(candidate["check_id"])
    pinned_artifact = stored["dependencies"]["snapshot_artifact_version_id"]
    assert pinned_artifact == reference["snapshot_artifact_version_id"]
    assert candidate["snapshot_artifact_version_id"] == pinned_artifact

    query = {
        "target": {"check_id": candidate["check_id"]},
        "operation": "finding_groups",
    }
    status, first_groups = post(running_server, "/api/docx-query", query)
    assert status == 200, first_groups
    assert built_roles == ["document_title"]
    status, cached_groups = post(running_server, "/api/docx-query", query)
    assert status == 200 and cached_groups["groups"] == first_groups["groups"]
    assert built_roles == ["document_title"]

    library_root = running_server.service.root
    running_server.service = WorkbenchService(library_root)
    later_facts = snapshot(content, size=21, role="body")
    assert later_facts["method_version"] == FORMAT_SNAPSHOT_METHOD_VERSION
    status, later_receipt = post(
        running_server,
        "/api/docx-format",
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "snapshot": later_facts,
        },
    )
    assert status == 200, later_receipt
    assert later_receipt["method_version"] == reference["method_version"]
    assert later_receipt["snapshot_artifact_version_id"] != pinned_artifact

    status, after_cache_clear = post(running_server, "/api/docx-query", query)
    assert status == 200, after_cache_clear
    assert after_cache_clear["groups"] == first_groups["groups"]
    assert built_roles == ["document_title", "document_title"]
    assert any(group["category"] == "title" for group in after_cache_clear["groups"])


def test_candidate_table_header_templates_replay_the_checked_world(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    template_facts, table_id = _table_header_snapshot(content)
    _, world, project, reference = _candidate_context(running_server, template_facts=template_facts)
    payload = _candidate_payload(project, world, reference, "candidate-table-header-replay")
    status, candidate = post(running_server, "/api/template-check", payload)
    assert status == 200, candidate
    expected = [
        {
            "column_count": 2,
            "rows": [
                {
                    "object_id": table_id + ".0",
                    "location": "Table 1 · R1",
                }
            ],
        }
    ]
    assert candidate["table_header_templates"] == expected

    later_content = template_bytes(((11906, 16838, 1440, 3),))
    status, later_world = post(running_server, "/api/template-world", adopt_payload(later_content))
    assert status == 200, later_world
    running_server.service.bind(
        project["project_id"],
        later_world["version_id"],
        candidate["binding_id"],
    )

    status, replay = post(running_server, "/api/template-check", payload)
    assert status == 200, replay
    assert replay["check_id"] == candidate["check_id"]
    assert replay["world_version_id"] == world["version_id"]
    assert replay["table_header_templates"] == expected


def test_candidate_reference_rejections_stale_baseline_and_new_bytes(running_server):
    content, world, project, reference = _candidate_context(running_server)
    rejection_statuses = []

    def rejected(payload):
        status, result = post(running_server, "/api/template-check", payload)
        rejection_statuses.append(status)
        return result

    rejected(
        _candidate_payload(
            project,
            world,
            {**reference, "source_sha256": "0" * 64},
            "candidate-wrong-source",
        )
    )
    rejected(
        _candidate_payload(
            project,
            world,
            {
                **reference,
                "snapshot_artifact_version_id": "artifact-version-" + "f" * 64,
            },
            "candidate-wrong-artifact",
        )
    )
    rejected(
        _candidate_payload(
            project,
            world,
            {**reference, "method_version": "docx-core-format-snapshot-1.2.0"},
            "candidate-wrong-method",
        )
    )
    assert running_server.service.store.list_checks(project["project_id"]) == []

    revised_content = template_bytes(((11906, 16838, 1440, 3),))
    status, revised = post(
        running_server,
        "/api/baseline",
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "reason": "Verify the next manuscript baseline against the selected template.",
            "request_id": "candidate-snapshot-revise",
            **upload(revised_content, "candidate-revised.docx"),
        },
    )
    assert status == 200 and revised["status"] == "APPLIED", revised
    revised_baseline = revised["result_baseline_id"]

    rejected(
        _candidate_payload(
            project,
            world,
            reference,
            "candidate-wrong-baseline",
            baseline_id=revised_baseline,
        )
    )
    assert running_server.service.store.list_checks(project["project_id"]) == []

    status, stale = post(
        running_server,
        "/api/template-check",
        _candidate_payload(
            project,
            world,
            reference,
            "candidate-stale-correct-reference",
        ),
    )
    assert status == 409, stale
    assert running_server.service.store.list_checks(project["project_id"]) == []

    status, revised_receipt = post(
        running_server,
        "/api/docx-format",
        {
            "project_id": project["project_id"],
            "baseline_id": revised_baseline,
            "snapshot": snapshot(revised_content, size=11),
        },
    )
    assert status == 200, revised_receipt
    revised_reference = _reference(revised_receipt)
    assert revised_reference["baseline_id"] == revised_baseline
    assert revised_reference["source_sha256"] == sha256_bytes(revised_content)
    assert (
        revised_reference["snapshot_artifact_version_id"]
        != reference["snapshot_artifact_version_id"]
    )

    status, checked = post(
        running_server,
        "/api/template-check",
        _candidate_payload(
            project,
            world,
            revised_reference,
            "candidate-revised-check",
            baseline_id=revised_baseline,
        ),
    )
    assert status == 200, checked
    assert checked["baseline_id"] == revised_baseline
    assert checked["source_sha256"] == sha256_bytes(revised_content)
    assert (
        checked["snapshot_artifact_version_id"]
        == (revised_reference["snapshot_artifact_version_id"])
    )
    assert len(running_server.service.store.list_checks(project["project_id"])) == 1

    status, mismatched = post(
        running_server,
        "/api/projects",
        {"name": "Different target bytes", **upload(content, "different-target.docx")},
    )
    assert status == 200, mismatched
    status, refused_copy = post(
        running_server,
        "/api/docx-format",
        {
            "project_id": mismatched["project_id"],
            "baseline_id": mismatched["baseline_id"],
            "retained_snapshot": {
                "project_id": project["project_id"],
                "reference": revised_reference,
            },
        },
    )
    assert status == 400, refused_copy

    status, matching = post(
        running_server,
        "/api/projects",
        {"name": "Matching target bytes", **upload(revised_content, "matching-target.docx")},
    )
    assert status == 200, matching
    status, copied = post(
        running_server,
        "/api/docx-format",
        {
            "project_id": matching["project_id"],
            "baseline_id": matching["baseline_id"],
            "retained_snapshot": {
                "project_id": project["project_id"],
                "reference": revised_reference,
            },
        },
    )
    assert status == 200, copied
    copied_reference = _copied_reference(copied)
    assert copied_reference["baseline_id"] == matching["baseline_id"]
    assert copied_reference["source_sha256"] == revised_reference["source_sha256"]
    assert (
        copied_reference["snapshot_artifact_version_id"]
        == revised_reference["snapshot_artifact_version_id"]
    )
    assert copied_reference["method_version"] == revised_reference["method_version"]
    assert rejection_statuses == [400, 400, 400, 400]
