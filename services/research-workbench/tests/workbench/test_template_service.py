"""Template adoption and exact-baseline comparison through real local HTTP/storage."""

import base64
from copy import deepcopy
from io import BytesIO
from zipfile import ZipFile

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from tests.journals.test_analysis import template_bytes
from tests.workbench.test_server import _request


def snapshot(content, *, size=14, role="document_title"):
    with ZipFile(BytesIO(content)) as archive:
        parts = [
            {
                "name": "/" + name,
                "content_type": "application/xml",
                "byte_length": len(archive.read(name)),
                "sha256": sha256_bytes(archive.read(name)),
                "xml": name.endswith(".xml"),
                "status": "parsed",
                "node_count": 1,
            }
            for name in archive.namelist()
        ]
    return {
        "schema_version": 1,
        "source_sha256": sha256_bytes(content),
        "engine": {"name": "@docx-editor.dev/core", "version": "2.36.0"},
        "parts": parts,
        "objects": [
            {
                "object_id": "/word/document.xml#0.0.0",
                "part": "/word/document.xml",
                "path": [0, 0, 0],
                "kind": "run",
                "role": role,
                "role_basis": [],
                "text": "Sample",
                "properties": {"run": {"fontSizePt": size}, "script_usage": {"latin": True}},
                "declared": {},
                "evidence": {},
            }
        ],
        "capabilities": {},
        "unsupported": [],
    }


def upload(content, name):
    return {"filename": name, "content_base64": base64.b64encode(content).decode()}


def adopt_payload(content):
    return {
        "journal_id": "template-test",
        "journal_name": "Template Test",
        "article_type": "research_article",
        "stage": "initial_submission",
        "language": "en",
        "original": upload(content, "template.docx"),
        "normalized": {**upload(content, "template.docx"), "provenance": None},
        "snapshot": snapshot(content),
    }


def post(server, path, payload):
    return _request(server, "POST", path, payload, server.session_token)


def setup_comparison(server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, world = post(server, "/api/template-world", adopt_payload(content))
    assert status == 200, world
    status, project = post(
        server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    status, retained = post(
        server,
        "/api/docx-format",
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "snapshot": snapshot(content, size=12),
        },
    )
    assert status == 200, retained
    request = {
        "project_id": project["project_id"],
        "expected_baseline_id": project["baseline_id"],
        "world_version_id": world["version_id"],
        "expected_binding_id": None,
        "request_id": "compare-1",
        "origin": {"surface": "agent"},
    }
    return content, world, project, request


def test_template_adoption_retains_original_normalized_and_complete_facts(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    payload = adopt_payload(content)
    payload["original"] = upload(b"\xd0\xcf\x11\xe0legacy-captured-input", "template.doc")
    payload["normalized"]["provenance"] = {
        "engine": "LibreOffice",
        "version": "25.2",
        "method": "doc-to-docx",
        "converted_sha256": sha256_bytes(content),
    }
    status, world = post(running_server, "/api/template-world", payload)
    assert status == 200, world
    metadata = world["template"]
    assert metadata["original_sha256"] != metadata["source_sha256"]
    assert running_server.service.store.read_source(metadata["source_id"]) == base64.b64decode(
        payload["original"]["content_base64"]
    )
    assert all(
        rule["confirmation_method"] == "explicit_template_selection" for rule in world["rules"]
    )
    status, result = post(
        running_server,
        "/api/docx-query",
        {"target": {"world_version_id": world["version_id"]}, "operation": "snapshot"},
    )
    assert status == 200 and result["snapshot"] == payload["snapshot"]
    status, result = post(
        running_server,
        "/api/docx-query",
        {"target": {"world_version_id": world["version_id"]}, "operation": "nodes", "limit": 1},
    )
    assert status == 200 and result["has_more"] and result["total"] > 1


def test_object_check_is_retained_idempotent_and_reports_actual_objects(running_server):
    _, world, project, request = setup_comparison(running_server)
    status, checked = post(running_server, "/api/template-check", request)
    assert status == 200, checked
    assert checked["validity"] == "CURRENT"
    finding = checked["template_comparison"]["findings"][0]
    assert finding["observed"] == 12 and finding["expected"] == 14
    assert finding["role"] == "document_title"
    status, repeated = post(running_server, "/api/template-check", request)
    assert status == 200 and repeated["check_id"] == checked["check_id"]
    assert len(running_server.service.store.list_checks(project["project_id"])) == 1
    changed = {**request, "origin": {"surface": "user"}}
    status, result = post(running_server, "/api/template-check", changed)
    assert status == 409, result
    assert (
        running_server.service.store.get_world(world["version_id"])["template"] == world["template"]
    )


def test_capture_rejects_missing_parts_and_wrong_source_hash(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    payload = adopt_payload(content)
    payload["snapshot"]["parts"].pop()
    status, result = post(running_server, "/api/template-world", payload)
    assert status == 400, result
    payload = adopt_payload(content)
    payload["snapshot"]["source_sha256"] = "0" * 64
    status, result = post(running_server, "/api/template-world", payload)
    assert status == 400, result


def test_template_font_requirements_use_only_active_text_slots(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    payload = adopt_payload(content)
    facts = payload["snapshot"]
    seed = facts["objects"][0]
    facts["objects"] = [
        {
            **seed,
            "object_id": f"/word/document.xml#0.{index}",
            "path": [0, index],
            "text": text,
            "kind": kind,
            "role": role,
            "properties": {
                "run": {
                    "fontFamily": "Times New Roman",
                    "fontFamilyEastAsia": "宋体",
                    "complexLane": {"fontFamily": "Arabic Exact"},
                },
                "script_usage": usage,
            },
        }
        for index, (text, kind, role, usage) in enumerate(
            [
                ("Sample", "run", "document_title", {"latin": True}),
                ("正文", "run", "body", {"east_asian": True}),
                ("混合Sample", "run", "body", {"east_asian": True, "latin": True}),
                ("", "run", "body", {"complex": True}),
                ("Marker", "paragraph", "body", {"complex": True}),
                ("عربي", "run", "abstract", {"complex": True}),
            ]
        )
    ]
    status, world = post(running_server, "/api/template-world", payload)
    assert status == 200, world
    assert world["template"]["font_requirements"] == [
        {"family": "Arabic Exact", "roles": ["abstract"], "scripts": ["complex"]},
        {"family": "Times New Roman", "roles": ["body", "document_title"], "scripts": ["latin"]},
        {"family": "宋体", "roles": ["body"], "scripts": ["east_asian"]},
    ]


def test_region_snapshots_compare_front_and_body_columns_over_http(running_server):
    content = template_bytes(((11906, 16838, 1440, 1), (11906, 16838, 1440, 2)))
    facts = snapshot(content)
    seed = facts["objects"][0]
    facts["objects"] = [
        {
            **seed,
            "object_id": f"/word/document.xml#0.{index}",
            "path": [0, index],
            "kind": "section",
            "role": "unknown",
            "properties": {"section": {"columns": {"count": columns}}},
            "region": {
                "section_object_id": f"/word/document.xml#0.{index}",
                "role": role,
                "role_basis": [],
            },
        }
        for index, (role, columns) in enumerate([("front_matter", 1), ("body", 2)])
    ]
    payload = adopt_payload(content)
    payload["snapshot"] = facts
    status, world = post(running_server, "/api/template-world", payload)
    assert status == 200, world
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    draft = deepcopy(facts)
    for item in draft["objects"]:
        item["properties"]["section"]["columns"]["count"] = (
            3 - item["properties"]["section"]["columns"]["count"]
        )
    status, captured = post(
        running_server,
        "/api/docx-format",
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "snapshot": draft,
        },
    )
    assert status == 200, captured
    status, checked = post(
        running_server,
        "/api/template-check",
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "world_version_id": world["version_id"],
            "expected_binding_id": None,
            "request_id": "region-columns",
            "origin": {"surface": "user"},
        },
    )
    assert status == 200, checked
    findings = checked["template_comparison"]["findings"]
    assert len(findings) == 2 and all(item["verdict"] == "observed_difference" for item in findings)
    assert [(item["region"]["role"], item["expected"]) for item in findings] == [
        ("front_matter", 1),
        ("body", 2),
    ]


def test_template_world_aggregates_core_and_role_gaps_without_copying_facts(running_server):
    content = template_bytes(((11906, 16838, 1440, 1),))
    payload = adopt_payload(content)
    facts = payload["snapshot"]
    first = facts["objects"][0]
    facts["objects"] = [
        {
            **first,
            "object_id": f"/word/document.xml#0.{index}",
            "path": [0, index],
            "role": "unknown",
        }
        for index in range(200)
    ]
    facts["unsupported"] = [
        {
            "code": "structural_only",
            "detail": "raw data remains queryable",
            "object_ids": [item["object_id"]],
        }
        for item in facts["objects"]
    ]
    status, world = post(running_server, "/api/template-world", payload)
    assert status == 200, world
    gaps = {item["code"]: item for item in world["coverage_gaps"]}
    assert set(gaps) == {"core_structural_only", "template_unknown_role"}
    assert all("200 retained" in item["message"] for item in gaps.values())
    assert all(
        item["source_id"] == world["template"]["normalized_source_id"] for item in gaps.values()
    )
    assert all(item["locator"] == "/word/document.xml#0.0" for item in gaps.values())


def test_implicit_core_section_identity_binds_its_enumerated_index(running_server):
    content = template_bytes(((11906, 16838, 1440, 1),))
    payload = adopt_payload(content)
    identity = "/word/document.xml#implicit-section-0"
    item = payload["snapshot"]["objects"][0]
    item.update(
        object_id=identity,
        path=[],
        kind="section",
        evidence={"implicit": True, "core_section": {"index": 0}},
        region={"section_object_id": identity, "role": "body", "role_basis": []},
    )
    status, world = post(running_server, "/api/template-world", payload)
    assert status == 200, world
    item["evidence"]["core_section"]["index"] = 1
    status, refused = post(running_server, "/api/template-world", payload)
    assert status == 400, refused


def test_binding_conflict_does_not_overwrite_current_selection(running_server):
    _, _, project, request = setup_comparison(running_server)
    status, first = post(running_server, "/api/template-check", request)
    assert status == 200
    conflicting = deepcopy(request)
    conflicting["request_id"] = "compare-2"
    conflicting["expected_binding_id"] = "binding-not-current"
    status, result = post(running_server, "/api/template-check", conflicting)
    assert status == 409, result
    assert (
        running_server.service.store.get_binding(project["project_id"])["binding_id"]
        == first["binding_id"]
    )


def test_check_replay_after_baseline_save_keeps_historical_findings(running_server):
    _, _, project, request = setup_comparison(running_server)
    status, checked = post(running_server, "/api/template-check", request)
    assert status == 200, checked
    status, saved = post(
        running_server,
        "/api/baseline",
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "filename": "revised.docx",
            "reason": "Save a changed document after the template comparison",
            "request_id": "save-after-template-check",
            **upload(template_bytes(((11906, 16838, 1440, 1),)), "revised.docx"),
        },
    )
    assert status == 200 and saved["status"] == "APPLIED", saved
    status, replayed = post(running_server, "/api/template-check", request)
    assert status == 200 and replayed["check_id"] == checked["check_id"], replayed
    assert replayed["validity"] == "STALE"
    assert "source_baseline_changed" in replayed["stale_reasons"]
    assert replayed["template_comparison"] == checked["template_comparison"]
    status, historical = post(
        running_server,
        "/api/docx-query",
        {
            "target": {"check_id": checked["check_id"]},
            "operation": "findings",
            "limit": 1,
        },
    )
    assert status == 200 and historical["findings"] == checked["template_comparison"]["findings"]


def test_selected_template_existing_review_and_discovery_remain_usable(running_server):
    _, world, project, request = setup_comparison(running_server)
    status, review = _request(
        running_server, "GET", f"/api/review?version_id={world['version_id']}"
    )
    assert status == 200, review
    assert any(fragment["kind"] == "template_object" for fragment in review["fragments"])
    assert all(link["link_status"] == "located" for link in review["rule_links"])
    fragments = {fragment["fragment_id"]: fragment for fragment in review["fragments"]}
    for link in review["rule_links"]:
        for identity in link["fragment_ids"]:
            assert fragments[identity]["source_id"] == world["template"]["normalized_source_id"]
            assert fragments[identity]["part_path"] == "/word/document.xml"
    status, checked = post(running_server, "/api/template-check", request)
    assert status == 200, checked
    status, state = _request(running_server, "GET", "/api/state")
    assert status == 200, state
    assert state["capabilities"]["object_template_checks"] is True
    assert state["projects"][0]["latest_check"]["check_id"] == checked["check_id"]
    status, raw = post(
        running_server,
        "/api/docx-query",
        {
            "target": {"project_id": project["project_id"], "baseline_id": project["baseline_id"]},
            "operation": "part",
            "part": "/word/document.xml",
        },
    )
    assert status == 200 and b"document" in base64.b64decode(raw["content_base64"])


def test_template_keeps_and_checks_additional_guide_requirements(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    payload = adopt_payload(content)
    payload["snapshot"]["unsupported"] = [
        {
            "code": "structural_only",
            "detail": "Retained core structure",
            "object_ids": [payload["snapshot"]["objects"][0]["object_id"]],
        }
    ]
    payload["sources"] = [
        {
            "name": "guide.txt",
            "kind": "guide_text",
            "content_base64": base64.b64encode(b"All manuscript pages must use 1 column.").decode(),
        }
    ]
    status, world = post(running_server, "/api/template-world", payload)
    assert status == 200, world
    assert any(rule["property"] == "columns" for rule in world["rules"])
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200
    status, captured = post(
        running_server,
        "/api/docx-format",
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "snapshot": snapshot(content),
        },
    )
    assert status == 200, captured
    status, checked = post(
        running_server,
        "/api/template-check",
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "world_version_id": world["version_id"],
            "expected_binding_id": None,
            "request_id": "guide-check",
            "origin": {"surface": "user"},
        },
    )
    assert status == 200, checked
    columns = next(item for item in checked["rule_results"] if item["property"] == "columns")
    assert columns["verdict"] == "violation"
    assert checked["template_comparison"]["finding_summary"]["observed_match"] == 1


def test_findings_are_retained_once_and_filtered_with_bounded_pages(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, world = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    facts = snapshot(content, size=12)
    first = facts["objects"][0]
    facts["objects"] = [
        {**first, "object_id": f"/word/document.xml#0.{index}", "path": [0, index]}
        for index in range(250)
    ]
    assert (
        post(
            running_server,
            "/api/docx-format",
            {
                "project_id": project["project_id"],
                "baseline_id": project["baseline_id"],
                "snapshot": facts,
            },
        )[0]
        == 200
    )
    status, checked = post(
        running_server,
        "/api/template-check",
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "world_version_id": world["version_id"],
            "expected_binding_id": None,
            "request_id": "many-cases",
            "origin": {"surface": "agent"},
        },
    )
    assert status == 200, checked
    comparison = checked["template_comparison"]
    assert comparison["total"] == 250 and len(comparison["findings"]) == 100
    assert comparison["has_more"] and comparison["next_offset"] == 100
    query = {
        "target": {"check_id": checked["check_id"]},
        "operation": "findings",
        "offset": 100,
        "limit": 100,
        "verdict": "observed_difference",
        "role": "document_title",
        "property_path": "run.fontSizePt",
    }
    status, page = post(running_server, "/api/docx-query", query)
    assert status == 200 and page["total"] == 250 and page["next_offset"] == 200
    assert page["findings"][0]["object_id"] == "/word/document.xml#0.100"
    status, empty = post(running_server, "/api/docx-query", {**query, "verdict": "observed_match"})
    assert status == 200 and empty["total"] == 0 and not empty["has_more"]


@pytest.mark.parametrize("target_kind", ["world", "baseline"])
def test_snapshot_optional_pagination_keeps_metadata_and_reaches_later_objects(
    running_server, target_kind
):
    content = template_bytes(((11906, 16838, 1440, 2),))
    facts = snapshot(content)
    first = facts["objects"][0]
    facts["objects"] = [
        {**first, "object_id": f"/word/document.xml#0.{index}", "path": [0, index]}
        for index in range(3)
    ]
    payload = adopt_payload(content)
    payload["snapshot"] = facts
    status, world = post(running_server, "/api/template-world", payload)
    assert status == 200, world
    target = {"world_version_id": world["version_id"]}
    if target_kind == "baseline":
        status, project = post(
            running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
        )
        assert status == 200, project
        target = {"project_id": project["project_id"], "baseline_id": project["baseline_id"]}
        status, captured = post(running_server, "/api/docx-format", {**target, "snapshot": facts})
        assert status == 200, captured
    query = {"target": target, "operation": "snapshot"}
    status, full = post(running_server, "/api/docx-query", query)
    assert status == 200 and full["snapshot"] == facts and "total" not in full
    status, page = post(running_server, "/api/docx-query", {**query, "limit": 2})
    assert status == 200, page
    assert page["total"] == 3 and page["next_offset"] == 2 and page["has_more"]
    assert page["snapshot"] == {**facts, "objects": facts["objects"][:2]}
    status, last = post(
        running_server, "/api/docx-query", {**query, "offset": page["next_offset"], "limit": 2}
    )
    assert status == 200 and last["snapshot"]["objects"] == facts["objects"][2:]
    assert last["total"] == 3 and not last["has_more"] and last["next_offset"] is None
    for pagination in ({"limit": 1001}, {"offset": -1}, {"limit": True}):
        status, refused = post(running_server, "/api/docx-query", {**query, **pagination})
        assert status == 400, refused
