"""Template adoption and exact-baseline comparison through real local HTTP/storage."""

import base64
import sqlite3
from copy import deepcopy
from io import BytesIO
from zipfile import ZipFile

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import decode_json_object, encode_json_object
from research_file_workbench.docx.format_snapshot import FORMAT_SNAPSHOT_METHOD_VERSION
from research_file_workbench.journals.models import world_version_id
from research_file_workbench.journals.revisions import revise_rule
from research_file_workbench.journals.store_records import BindingConflictError, WorldStoreError
from research_file_workbench.journals.template_models import (
    template_coverage_gaps,
    template_font_requirements,
    template_rules,
)
from research_file_workbench.projects.store import ProjectStore
from research_file_workbench.workbench import service as workbench_service
from research_file_workbench.workbench.template_service import (
    TemplatePreparationError,
    prepare_template,
    query_document,
    template_preparation,
)
from tests.journals.test_analysis import component_bytes, template_bytes
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
        "method_version": FORMAT_SNAPSHOT_METHOD_VERSION,
        "schema_version": 1,
        "source_sha256": sha256_bytes(content),
        "engine": {"name": "@docx-editor.dev/core", "version": "2.36.0"},
        "parts": parts,
        "style_definitions": [],
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


def adopt_payload(content, *, journal_id="template-test", journal_name="Template Test"):
    return {
        "journal_id": journal_id,
        "journal_name": journal_name,
        "article_type": "research_article",
        "stage": "initial_submission",
        "language": "en",
        "original": upload(content, "template.docx"),
        "normalized": {**upload(content, "template.docx"), "provenance": None},
        "snapshot": snapshot(content),
    }


def four_group_snapshot(content):
    facts = snapshot(content)
    seed = facts["objects"][0]
    facts["objects"] = [
        {
            **seed,
            "object_id": f"/word/document.xml#{'.'.join(map(str, path))}",
            "path": path,
            "kind": kind,
            "role": role,
            "text": text,
            "properties": {
                "run": {"fontSizePt": 14, "fontFamily": "Times New Roman"},
                "script_usage": {"latin": True},
            },
        }
        for path, kind, role, text in (
            ([0, 0], "paragraph", "document_title", "Title"),
            ([0, 1], "paragraph", "body", "Body"),
            ([0, 2, 0], "run", "document_title", "Title"),
            ([0, 3, 0], "run", "body", "Body"),
        )
    ]
    return facts


def review_object_id(path, part="/word/document.xml"):
    return f"{part}#{'.'.join(map(str, path))}"


def review_object(
    path,
    kind,
    role,
    properties,
    *,
    text="",
    paragraph_id=None,
    para_id=None,
    region=None,
    table_context=None,
):
    result = {
        "object_id": review_object_id(path),
        "part": "/word/document.xml",
        "path": path,
        "kind": kind,
        "role": role,
        "role_basis": [],
        "text": text,
        "properties": properties,
        "declared": (
            {"attributes": [{"localName": "paraId", "value": para_id}]} if para_id else {}
        ),
        "evidence": {"paragraph_object_id": paragraph_id} if paragraph_id else {},
    }
    if region is not None:
        result["region"] = region
    if table_context is not None:
        result["table_context"] = table_context
    return result


def review_snapshots(content):
    section = review_object_id([0, 11])
    table = review_object_id([0, 10])
    body_region = {"section_object_id": section, "role": "body", "role_basis": []}
    references_region = {
        "section_object_id": section,
        "role": "references",
        "role_basis": [],
    }

    def paragraph(path, role, text, *, alignment="both", para_id=None, region=None):
        return review_object(
            path,
            "paragraph",
            role,
            {"paragraph": {"alignment": alignment}},
            text=text,
            para_id=para_id,
            region=region,
        )

    def run(path, role, size, paragraph, *, text=""):
        return review_object(
            path,
            "run",
            role,
            {
                "run": {"fontSizePt": size},
                "script_usage": {"latin": True},
            },
            text=text,
            paragraph_id=review_object_id(paragraph),
        )

    template = snapshot(content)
    template["objects"] = [
        paragraph(
            [0, 0],
            "document_title",
            "Title",
            alignment="center",
            para_id="11111111",
        ),
        run([0, 0, 0], "document_title", 14, [0, 0], text="Title"),
        {
            **paragraph(
                [0, 1],
                "heading",
                "Heading",
                para_id="22222222",
                region=body_region,
            ),
            "properties": {
                "paragraph": {
                    "alignment": "both",
                    "outlineLevel": 0,
                    "spacing": {"before": 240},
                }
            },
        },
        run([0, 1, 0], "heading", 16, [0, 1], text="Heading"),
        paragraph([0, 2], "body", "Body one", para_id="33333333", region=body_region),
        run([0, 2, 0], "body", 10, [0, 2], text="Body one"),
        paragraph([0, 3], "body", "Body two", para_id="44444444", region=body_region),
        run([0, 3, 0], "body", 10, [0, 3], text="Body two"),
        paragraph([0, 4], "body", "Body three", para_id="55555555", region=body_region),
        run([0, 4, 0], "body", 10, [0, 4], text="Body three"),
        paragraph(
            [0, 5],
            "caption",
            "Figure 1. Caption",
            alignment="center",
            para_id="66666666",
        ),
        paragraph(
            [0, 6],
            "caption",
            "Table 1. Caption",
            alignment="center",
            para_id="77777777",
        ),
        paragraph([0, 7], "body", "Formula paragraph", para_id="88888888", region=body_region),
        review_object(
            [0, 7, 0],
            "omath",
            "body",
            {"run": {"fontSizePt": 12}, "script_usage": {"latin": True}},
            paragraph_id=review_object_id([0, 7]),
        ),
        paragraph([0, 8], "body", "Figure paragraph", para_id="99999999", region=body_region),
        review_object(
            [0, 8, 0],
            "drawing",
            "body",
            {"drawing": {"widthPt": 100}},
            paragraph_id=review_object_id([0, 8]),
        ),
        paragraph(
            [0, 9],
            "body",
            "Reference entry",
            alignment="left",
            para_id="aaaaaaaa",
            region=references_region,
        ),
        review_object(
            [0, 10],
            "table",
            "unknown",
            {"table": {"alignment": "center"}},
        ),
        review_object(
            [0, 10, 0],
            "tr",
            "unknown",
            {"row": {"isHeader": True, "height": 20}},
            table_context={
                "table_object_id": table,
                "row_index": 0,
                "row_count": 2,
                "conditions": ["firstRow"],
            },
        ),
        review_object(
            [0, 10, 1],
            "tr",
            "unknown",
            {"row": {"isHeader": False, "height": 18}},
            table_context={
                "table_object_id": table,
                "row_index": 1,
                "row_count": 2,
                "conditions": [],
            },
        ),
        review_object(
            [0, 10, 1, 0],
            "tc",
            "unknown",
            {"cell": {"widthTwips": 1000}},
            table_context={
                "table_object_id": table,
                "row_index": 1,
                "row_count": 2,
                "column_index": 0,
                "column_count": 2,
                "conditions": ["firstCol"],
            },
        ),
        review_object(
            [0, 11],
            "section",
            "unknown",
            {"section": {"columns": {"count": 2}}},
            region=body_region,
        ),
    ]
    template_by_id = {item["object_id"]: item for item in template["objects"]}
    for path in ([0, 2], [0, 3], [0, 4]):
        template_by_id[review_object_id(path)]["properties"]["paragraph"]["lineSpacing"] = {
            "rule": "auto",
            "value": 240,
        }
    manuscript = deepcopy(template)
    by_id = {item["object_id"]: item for item in manuscript["objects"]}
    by_id[review_object_id([0, 0, 0])]["properties"]["run"]["fontSizePt"] = 12
    by_id[review_object_id([0, 1])]["properties"]["paragraph"]["spacing"]["before"] = 120
    by_id[review_object_id([0, 1, 0])]["properties"]["run"]["fontSizePt"] = 14
    by_id[review_object_id([0, 2])]["properties"]["paragraph"]["lineSpacing"] = {
        "rule": "exact",
        "value": None,
    }
    by_id[review_object_id([0, 5])]["properties"]["paragraph"]["alignment"] = "left"
    by_id[review_object_id([0, 6])]["properties"]["paragraph"]["alignment"] = "left"
    by_id[review_object_id([0, 7, 0])]["properties"]["run"]["fontSizePt"] = 14
    by_id[review_object_id([0, 8, 0])]["properties"]["drawing"]["widthPt"] = 120
    by_id[review_object_id([0, 9])]["properties"]["paragraph"]["alignment"] = "both"
    by_id[table]["properties"]["table"]["alignment"] = "left"
    by_id[review_object_id([0, 10, 0])]["properties"]["row"]["height"] = 24
    by_id[review_object_id([0, 10, 1])]["properties"]["row"]["height"] = 20
    by_id[review_object_id([0, 10, 1, 0])]["properties"]["cell"]["widthTwips"] = 1200
    by_id[section]["properties"]["section"]["columns"]["count"] = 1
    manuscript["objects"].append(
        review_object(
            [0, 12],
            "run",
            "unknown",
            {"run": {"fontSizePt": 9}},
            text="Unclassified",
        )
    )
    return template, manuscript


def retain_legacy_template_world(
    server,
    current,
    *,
    method="docx-core-format-snapshot-1.2.0",
    facts=None,
    normalized=None,
):
    store = server.service.store
    legacy = {
        key: deepcopy(value)
        for key, value in current.items()
        if key not in {"created_at", "version_ordinal"}
    }
    template = legacy["template"]
    normalized_bytes = (
        normalized
        if normalized is not None
        else store.read_source(template["normalized_source_id"])
    )
    normalized_id = "source-" + sha256_bytes(normalized_bytes)
    snapshot = (
        deepcopy(facts)
        if facts is not None
        else decode_json_object(store.read_source(template["snapshot_source_id"]))
    )
    snapshot["method_version"] = method
    snapshot["source_sha256"] = sha256_bytes(normalized_bytes)
    snapshot_bytes = encode_json_object(snapshot).encode()
    snapshot_id = "source-" + sha256_bytes(snapshot_bytes)
    source_records = [
        deepcopy(item)
        for item in legacy["sources"]
        if item["kind"] not in {"template_docx", "docx_format_snapshot"}
    ]
    source_records.extend(
        [
            {
                "source_id": normalized_id,
                "sha256": sha256_bytes(normalized_bytes),
                "name": "template.docx",
                "kind": "template_docx",
                "status": "analyzed",
                "limitations": [],
            },
            {
                "source_id": snapshot_id,
                "sha256": sha256_bytes(snapshot_bytes),
                "name": "core-format-snapshot.json",
                "kind": "docx_format_snapshot",
                "status": "analyzed",
                "limitations": [],
            },
        ]
    )
    legacy["sources"] = source_records
    legacy["reader_version"] = method
    template["normalized_source_id"] = normalized_id
    template["snapshot_source_id"] = snapshot_id
    template["source_sha256"] = sha256_bytes(normalized_bytes)
    template["font_requirements"] = template_font_requirements(snapshot)
    legacy["rules"] = template_rules(snapshot, normalized_id) + [
        rule for rule in legacy["rules"] if rule["property"] != "object_format"
    ]
    legacy["coverage_gaps"] = template_coverage_gaps(snapshot, normalized_id)
    if sha256_bytes(normalized_bytes) != template["original_sha256"]:
        provenance = template.get("provenance")
        if not isinstance(provenance, dict):
            provenance = {}
        template["provenance"] = {
            **provenance,
            "engine": "LibreOffice",
            "version": "fixture",
            "method": "doc-to-docx",
            "converted_sha256": sha256_bytes(normalized_bytes),
        }
    legacy["version_id"] = world_version_id(legacy)
    sources = {
        item["source_id"]: store.read_source(item["source_id"])
        for item in source_records
        if item["kind"] != "template_docx" and item["kind"] != "docx_format_snapshot"
    }
    sources[normalized_id] = normalized_bytes
    sources[snapshot_id] = snapshot_bytes
    return store.save_world(legacy, sources)


def prepare(service, project, *, world_version_id=None, surface=None):
    payload = {
        "project_id": project["project_id"],
        "expected_baseline_id": project["baseline_id"],
    }
    if world_version_id is not None:
        payload["world_version_id"] = world_version_id
    if surface is not None:
        payload["surface"] = surface
    return prepare_template(service, payload)


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


def setup_review_comparison(server, *, request_id="review-1", response=None):
    content = template_bytes(((11906, 16838, 1440, 2),))
    template, manuscript = review_snapshots(content)
    payload = {**adopt_payload(content), "snapshot": template}
    status, world = post(server, "/api/template-world", payload)
    assert status == 200, world
    status, project = post(
        server, "/api/projects", {"name": "Review draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    status, retained = post(
        server,
        "/api/docx-format",
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "snapshot": manuscript,
        },
    )
    assert status == 200, retained
    request = {
        "project_id": project["project_id"],
        "expected_baseline_id": project["baseline_id"],
        "world_version_id": world["version_id"],
        "expected_binding_id": None,
        "request_id": request_id,
        "origin": {"surface": "agent"},
    }
    if response is not None:
        request["response"] = response
    status, checked = post(server, "/api/template-check", request)
    assert status == 200, checked
    return content, world, project, request, checked


def test_template_adoption_retains_original_normalized_and_complete_facts(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    payload = adopt_payload(content)
    payload["original"] = upload(
        b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1legacy-captured-input", "template.doc"
    )
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


def test_start_template_copy_retains_exact_bytes_and_replays_without_rebinding(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, world = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200
    payload = {
        "world_version_id": world["version_id"],
        "name": "New draft",
        "request_id": "start-one",
    }
    status, created = post(running_server, "/api/template-copy", payload)
    assert status == 200, created
    project = created["project"]
    assert project["binding"]["world_version_id"] == world["version_id"]
    source = running_server.service.manuscript_source(project["project_id"], project["baseline_id"])
    assert base64.b64decode(source["content_base64"]) == content
    assert created["origin"]["source_sha256"] == sha256_bytes(content)
    status, replay = post(running_server, "/api/template-copy", payload)
    assert status == 200 and replay == created
    assert len(running_server.service.state()["projects"]) == 1
    assert len(running_server.service.store.list_bindings(project["project_id"])) == 1
    status, conflict = post(running_server, "/api/template-copy", {**payload, "name": "Other name"})
    assert status == 409, conflict
    assert len(running_server.service.state()["projects"]) == 1
    assert (
        running_server.service.store.read_source(world["template"]["normalized_source_id"])
        == content
    )


def test_template_source_returns_only_selected_retained_normalized_bytes(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, world = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200
    status, result = _request(
        running_server, "GET", "/api/template-source?world_version_id=" + world["version_id"]
    )
    assert status == 200, result
    assert result["world_version_id"] == world["version_id"]
    assert result["source_sha256"] == sha256_bytes(content)
    assert base64.b64decode(result["content_base64"]) == content
    assert not running_server.service.state()["projects"]


def test_start_template_copy_requires_a_selected_template(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, world = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200
    status, result = post(
        running_server,
        "/api/template-copy",
        {
            "world_version_id": world["version_id"],
            "name": "Draft",
            "request_id": "unsafe/path",
        },
    )
    assert status == 400, result
    assert not running_server.service.state()["projects"]


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


def test_template_keeps_guides_without_automatic_requirements(running_server):
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
    assert all(rule["property"] == "object_format" for rule in world["rules"])
    assert any(gap["code"] == "guide_requires_interpretation" for gap in world["coverage_gaps"])
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
    assert all(item["property"] == "object_format" for item in checked["rule_results"])
    assert checked["summary"]["violation"] == 0
    assert checked["template_comparison"]["finding_summary"]["observed_match"] == 1


def test_template_checks_explicit_component_alongside_object_facts(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    payload = adopt_payload(content)
    payload["sources"] = [
        {
            "name": "requirements.json",
            "kind": "rule_component_json",
            "content_base64": base64.b64encode(
                component_bytes({"columns": 1}, journal_id="template-test")
            ).decode(),
        }
    ]
    status, world = post(running_server, "/api/template-world", payload)
    assert status == 200, world
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
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
            "request_id": "explicit-component-check",
            "origin": {"surface": "agent"},
        },
    )
    assert status == 200, checked
    component = next(item for item in checked["rule_results"] if item["property"] == "columns")
    assert component["basis_status"] == "candidate"
    assert component["verdict"] == "observed_difference"
    assert checked["summary"]["violation"] == 0
    assert checked["template_comparison"]["finding_summary"]["observed_match"] == 1


def test_findings_are_retained_once_and_filtered_with_bounded_pages(running_server, monkeypatch):
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
    artifact_reads = []
    artifact_decodes = []
    read_artifact = ProjectStore.read_artifact
    decode_json_object = workbench_service.decode_json_object

    def tracked_read(store, version_id):
        artifact_reads.append(version_id)
        return read_artifact(store, version_id)

    def tracked_decode(content):
        artifact_decodes.append(len(content))
        return decode_json_object(content)

    monkeypatch.setattr(ProjectStore, "read_artifact", tracked_read)
    monkeypatch.setattr(workbench_service, "decode_json_object", tracked_decode)
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
    status, tail = post(running_server, "/api/docx-query", {**query, "offset": 200})
    assert status == 200 and tail["total"] == 250 and tail["next_offset"] is None
    assert tail["findings"][0]["object_id"] == "/word/document.xml#0.200"
    assert len(tail["findings"]) == 50
    status, head = post(running_server, "/api/docx-query", {**query, "offset": 0})
    assert status == 200 and head["total"] == 250 and head["next_offset"] == 100
    assert head["findings"][0]["object_id"] == "/word/document.xml#0.0"
    status, empty = post(running_server, "/api/docx-query", {**query, "verdict": "observed_match"})
    assert status == 200 and empty["total"] == 0 and not empty["has_more"]
    assert artifact_reads == []
    assert artifact_decodes == []

    # A process that did not commit this check still verifies and decodes its retained artifact.
    cold_service = workbench_service.WorkbenchService(running_server.service.root)
    cold = query_document(cold_service, query)
    assert cold["findings"][0]["object_id"] == "/word/document.xml#0.100"
    assert artifact_reads == [comparison["findings_artifact_version_id"]]
    assert len(artifact_decodes) == 1


def finding_group(groups, *, category, action, **fields):
    matches = [
        group
        for group in groups
        if group["category"] == category
        and group["action"] == action
        and all(group.get(key) == value for key, value in fields.items())
    ]
    assert len(matches) == 1, matches
    return matches[0]


def test_finding_groups_locations_and_details_share_the_checked_projection(running_server):
    _, _, project, _, checked = setup_review_comparison(running_server)
    check_id = checked["check_id"]
    target = {"check_id": check_id}

    status, review = post(
        running_server,
        "/api/docx-query",
        {"target": target, "operation": "finding_groups"},
    )
    assert status == 200, review
    assert review["check_id"] == check_id
    assert review["baseline_id"] == project["baseline_id"]
    assert review["source_sha256"] == checked["source_sha256"]
    assert review["summary"]["finding_count"] == checked["template_comparison"]["total"]
    assert review["summary"]["counts"] == {
        verdict: checked["template_comparison"]["finding_summary"][verdict]
        for verdict in ("observed_match", "observed_difference", "cannot_determine")
    }
    assert {group["category"] for group in review["groups"]} == {
        "title",
        "heading",
        "body",
        "table",
        "formula",
        "figure",
        "figure_caption",
        "table_caption",
        "references",
        "other",
    }
    assert {group["action"] for group in review["groups"]} <= {
        "font",
        "emphasis",
        "line_spacing",
        "paragraph_spacing",
        "indent",
        "alignment",
        "kerning",
        "page_flow",
        "borders",
        "cell_margins",
        "size",
        "numbering",
        "layout",
        "coverage",
        "other",
    }
    status, replay = post(
        running_server,
        "/api/docx-query",
        {"target": target, "operation": "finding_groups"},
    )
    assert status == 200 and replay["groups"] == review["groups"]

    title_size = finding_group(review["groups"], category="title", action="size")
    assert "heading_level" not in title_size
    heading_size = finding_group(review["groups"], category="heading", action="size")
    assert heading_size["heading_level"] == 1
    status, title_locations = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_locations",
            "group_id": title_size["id"],
            "verdict": "observed_difference",
            "limit": 10,
        },
    )
    assert status == 200, title_locations
    assert title_locations["total"] == 1 and not title_locations["has_more"]
    title_location = title_locations["locations"][0]
    assert title_location["para_id"] == "11111111"
    assert title_location["label"] == "Title"
    assert title_location["counts"]["observed_difference"] == 1

    body_size = finding_group(review["groups"], category="body", action="size")
    status, first = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_locations",
            "group_id": body_size["id"],
            "verdict": "observed_match",
            "limit": 2,
        },
    )
    assert status == 200 and first["total"] == 3 and first["next_offset"] == 2
    assert [item["label"] for item in first["locations"]] == ["Body one", "Body two"]
    status, last = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_locations",
            "group_id": body_size["id"],
            "verdict": "observed_match",
            "offset": first["next_offset"],
            "limit": 2,
        },
    )
    assert status == 200 and last["total"] == 3 and last["next_offset"] is None
    assert [item["label"] for item in last["locations"]] == ["Body three"]

    whole_table = finding_group(review["groups"], category="table", action="alignment")
    assert whole_table["object_number"] == 1
    assert "table_area" not in whole_table

    header = finding_group(review["groups"], category="table", action="layout", table_area="header")
    header_location = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_locations",
            "group_id": header["id"],
            "verdict": "observed_difference",
        },
    )[1]["locations"][0]
    assert header_location["object_number"] == 1
    assert header_location["row"] == 1
    assert "column" not in header_location

    body = finding_group(review["groups"], category="table", action="layout", table_area="body")
    body_location = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_locations",
            "group_id": body["id"],
            "verdict": "observed_difference",
        },
    )[1]["locations"][0]
    assert (body_location["row"], body_location.get("column")) == (2, None)

    exception = finding_group(
        review["groups"], category="table", action="layout", table_area="exception"
    )
    exception_location = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_locations",
            "group_id": exception["id"],
            "verdict": "observed_difference",
        },
    )[1]["locations"][0]
    assert (exception_location["row"], exception_location["column"]) == (2, 1)

    formula = finding_group(review["groups"], category="formula", action="size")
    figure = finding_group(review["groups"], category="figure", action="layout")
    section = finding_group(review["groups"], category="body", action="layout")
    assert formula["object_number"] == 1
    assert figure["object_number"] == 1
    for group, paragraph_id, label in (
        (formula, "88888888", "Formula paragraph"),
        (figure, "99999999", "Figure paragraph"),
        (section, "22222222", "Heading"),
    ):
        status, page = post(
            running_server,
            "/api/docx-query",
            {
                "target": target,
                "operation": "finding_locations",
                "group_id": group["id"],
            },
        )
        assert status == 200 and page["total"] == 1
        assert page["locations"][0]["para_id"] == paragraph_id
        assert page["locations"][0]["label"] == label

    status, details = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "findings",
            "group_id": title_size["id"],
            "location_id": title_location["id"],
            "verdict": "observed_difference",
        },
    )
    assert status == 200 and details["total"] == 1
    assert details["findings"][0]["object_id"] == "/word/document.xml#0.0.0"
    assert details["findings"][0]["property_path"] == "run.fontSizePt"
    assert details["findings"][0]["role"] == "document_title"

    status, refused = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_locations",
            "group_id": "group-absent",
        },
    )
    assert status == 400, refused
    status, refused = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "findings",
            "location_id": "location-absent",
        },
    )
    assert status == 400, refused


def test_grouped_details_attach_line_spacing_rule_from_the_same_retained_object(
    running_server,
):
    _, _, _, _, checked = setup_review_comparison(
        running_server,
        request_id="line-spacing-review",
    )
    target = {"check_id": checked["check_id"]}
    status, review = post(
        running_server,
        "/api/docx-query",
        {"target": target, "operation": "finding_groups"},
    )
    assert status == 200, review
    line_spacing = finding_group(review["groups"], category="body", action="line_spacing")
    status, locations = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_locations",
            "group_id": line_spacing["id"],
            "verdict": "cannot_determine",
            "limit": 100,
        },
    )
    assert status == 200, locations
    body_one = next(item for item in locations["locations"] if item["label"] == "Body one")
    status, details = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "findings",
            "group_id": line_spacing["id"],
            "location_id": body_one["id"],
            "property_path": "paragraph.lineSpacing.value",
            "verdict": "cannot_determine",
            "limit": 1,
        },
    )
    assert status == 200, details
    assert details["total"] == 1
    assert details["findings"][0]["line_spacing_rule"] == {
        "observed": "exact",
        "expected": "auto",
    }


def test_grouped_locations_use_the_reader_method_captured_by_the_check(running_server):
    content, _, project, _, checked = setup_review_comparison(
        running_server,
        request_id="reader-method-review",
    )
    from research_file_workbench.projects.service import open_project

    later = snapshot(content)
    later["method_version"] = "docx-core-format-snapshot-1.2.0"
    later["objects"] = []
    open_project(running_server.service.project_root(project["project_id"])).save_format_snapshot(
        project["baseline_id"],
        later,
    )
    target = {"check_id": checked["check_id"]}
    status, review = post(
        running_server,
        "/api/docx-query",
        {"target": target, "operation": "finding_groups"},
    )
    assert status == 200, review
    title_size = finding_group(review["groups"], category="title", action="size")
    status, locations = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_locations",
            "group_id": title_size["id"],
            "verdict": "observed_difference",
        },
    )
    assert status == 200, locations
    assert locations["locations"][0]["para_id"] == "11111111"


def test_candidate_findings_and_verification_return_only_recorded_evidence(running_server):
    _, _, _, _, checked = setup_review_comparison(running_server, request_id="candidate-review")
    check_id = checked["check_id"]
    target = {"check_id": check_id}
    findings = checked["template_comparison"]["findings"]

    status, candidates = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "candidate_findings",
            "property_paths": ["run.fontSizePt", "table.alignment"],
            "limit": 100,
        },
    )
    assert status == 200, candidates
    assert candidates["total"] == 3
    assert {item["property_path"] for item in candidates["findings"]} == {"run.fontSizePt"}
    assert all(item["verdict"] == "observed_difference" for item in candidates["findings"])
    assert all(item["expected_value_count"] == 1 for item in candidates["findings"])
    assert all("reason" not in item for item in candidates["findings"])
    assert all("table_context" not in item for item in candidates["findings"])
    assert all(item["template_object_ids"] for item in candidates["findings"])
    assert all(isinstance(item["template_object_count"], int) for item in candidates["findings"])
    expected_location_ids = {
        object_id
        for item in candidates["findings"]
        for object_id in item["template_object_ids"][:2]
    }
    assert set(candidates["template_locations"]) == expected_location_ids
    assert all(candidates["template_locations"].values())
    status, page = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "candidate_findings",
            "property_paths": ["run.fontSizePt", "table.alignment"],
            "limit": 1,
        },
    )
    assert status == 200 and len(page["findings"]) == 1
    assert page["total"] == 3 and page["next_offset"] == 1

    title = next(
        finding
        for finding in findings
        if finding["property_path"] == "run.fontSizePt" and finding["role"] == "document_title"
    )
    match = next(finding for finding in findings if finding["verdict"] == "observed_match")
    coverage = next(finding for finding in findings if finding["verdict"] == "cannot_determine")
    targets = [
        {
            "case_id": "case-from-the-edited-candidate",
            "property_path": title["property_path"],
            "object_ids": [title["object_id"]],
        },
        {
            "case_id": title["case_id"],
            "property_path": title["property_path"],
            "object_ids": [],
        },
        {
            "case_id": match["case_id"],
            "property_path": match["property_path"],
            "object_ids": [],
        },
        {
            "case_id": coverage["case_id"],
            "property_path": coverage["property_path"],
            "object_ids": [],
        },
    ]
    status, verified = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_verification",
            "targets": targets,
        },
    )
    assert status == 200, verified
    assert verified["total"] == 3 and verified["target_limit"] == 500
    assert {item["verdict"] for item in verified["findings"]} == {
        "observed_match",
        "observed_difference",
        "cannot_determine",
    }
    assert {item["case_id"] for item in verified["findings"]} == {
        match["case_id"],
        title["case_id"],
        coverage["case_id"],
    }
    assert all(
        set(item) <= {"case_id", "object_id", "property_path", "verdict", "observed"}
        for item in verified["findings"]
    )
    assert all(
        item.get("observed") is None or isinstance(item.get("observed"), (str, int, float, bool))
        for item in verified["findings"]
    )

    repeated = {
        "case_id": coverage["case_id"],
        "property_path": coverage["property_path"],
        "object_ids": [],
    }
    status, limited = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_verification",
            "targets": [repeated] * 500,
        },
    )
    assert status == 200 and limited["total"] == 1
    status, refused = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "finding_verification",
            "targets": [repeated] * 501,
        },
    )
    assert status == 400, refused


def test_summary_check_returns_groups_without_rewriting_retained_findings(
    running_server, monkeypatch
):
    _, _, project, request = setup_comparison(running_server)
    artifact_reads = []
    read_artifact = ProjectStore.read_artifact

    def tracked_read(store, version_id):
        artifact_reads.append(version_id)
        return read_artifact(store, version_id)

    monkeypatch.setattr(ProjectStore, "read_artifact", tracked_read)
    summary_request = {**request, "response": "summary"}
    status, checked = post(running_server, "/api/template-check", summary_request)
    assert status == 200, checked
    comparison = checked["template_comparison"]
    assert set(checked) == {
        "check_id",
        "project_id",
        "baseline_id",
        "world_version_id",
        "binding_id",
        "source_sha256",
        "validity",
        "template_comparison",
    }
    assert set(comparison) == {
        "source_sha256",
        "total",
        "finding_summary",
        "findings_artifact_version_id",
        "groups",
    }
    assert comparison["groups"]
    assert comparison["total"] == 1
    assert comparison["findings_artifact_version_id"] not in artifact_reads

    stored = running_server.service.store.get_check(checked["check_id"])
    assert "response" not in stored
    assert len(stored["template_comparison"]["findings"]) == 1
    assert (
        stored["template_comparison"]["findings_artifact_version_id"]
        == comparison["findings_artifact_version_id"]
    )

    artifact_reads.clear()
    status, groups = post(
        running_server,
        "/api/docx-query",
        {"target": {"check_id": checked["check_id"]}, "operation": "finding_groups"},
    )
    assert status == 200
    assert groups["groups"] == comparison["groups"]
    assert artifact_reads == []

    status, replayed = post(
        running_server,
        "/api/template-check",
        {key: value for key, value in summary_request.items() if key != "response"},
    )
    assert status == 200, replayed
    assert len(replayed["template_comparison"]["findings"]) == 1
    assert replayed["template_comparison"]["findings"] == stored["template_comparison"]["findings"]

    status, refused = post(
        running_server,
        "/api/template-check",
        {**request, "request_id": "invalid-response", "response": "full"},
    )
    assert status == 400, refused
    assert running_server.service.store.get_binding(project["project_id"]) is not None


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
    assert page["snapshot"] == {
        **{key: value for key, value in facts.items() if key != "style_definitions"},
        "objects": facts["objects"][:2],
    }
    status, last = post(
        running_server, "/api/docx-query", {**query, "offset": page["next_offset"], "limit": 2}
    )
    assert status == 200 and last["snapshot"]["objects"] == facts["objects"][2:]
    assert last["total"] == 3 and not last["has_more"] and last["next_offset"] is None
    for pagination in ({"limit": 1001}, {"offset": -1}, {"limit": True}):
        status, refused = post(running_server, "/api/docx-query", {**query, **pagination})
        assert status == 400, refused


def heading_template_snapshot(content):
    facts = snapshot(content)
    facts["style_definitions"] = [
        {
            "object_id": "/word/styles.xml#0.0",
            "part": "/word/styles.xml",
            "path": [0, 0],
            "style_id": "Heading3",
            "name": "heading 3",
            "type": "paragraph",
            "based_on": None,
            "role": "heading",
            "role_basis": [{"source": "outline_level", "value": "2", "certainty": "explicit"}],
            "properties": {
                "paragraph": {"outlineLevel": 2},
                "run": {"fontSizePt": 13, "fontFamily": "Unused Font"},
                "script_usage": {"latin": True, "east_asian": True, "complex": True, "other": True},
            },
        }
    ]
    return facts


def heading_template_content(extra_styles=""):
    stream = BytesIO(template_bytes())
    with ZipFile(stream, "a") as archive:
        archive.writestr(
            "word/styles.xml",
            '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>'
            '<w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:sz w:val="26"/>'
            '<w:rFonts w:ascii="Unused Font"/></w:rPr></w:style>'
            f"{extra_styles}</w:styles>",
        )
    return stream.getvalue()


def test_unused_style_facts_reach_rules_review_paged_reads_and_saved_check(running_server):
    content = heading_template_content()
    facts = heading_template_snapshot(content)
    payload = adopt_payload(content)
    payload["snapshot"] = facts
    status, world = post(running_server, "/api/template-world", payload)
    assert status == 200, world
    heading_rules = [rule for rule in world["rules"] if rule["scope"]["role"] == "heading"]
    assert {rule["scope"]["kind"] for rule in heading_rules} == {"paragraph", "run"}
    assert all(rule["template_object_ids"] == ["/word/styles.xml#0.0"] for rule in heading_rules)
    assert world["template"]["font_requirements"] == [
        {"family": "Unused Font", "roles": ["heading"], "scripts": ["complex", "latin", "other"]}
    ]
    status, review = _request(
        running_server, "GET", f"/api/review?version_id={world['version_id']}"
    )
    assert status == 200, review
    styles = [fragment for fragment in review["fragments"] if fragment["kind"] == "template_style"]
    assert len(styles) == 1 and styles[0]["part_path"] == "/word/styles.xml"
    assert all(link["link_status"] == "located" for link in review["rule_links"])
    target = {"world_version_id": world["version_id"]}
    status, page = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "snapshot",
            "collection": "style_definitions",
            "limit": 1,
        },
    )
    assert status == 200 and page["total"] == 1, page
    assert page["snapshot"]["style_definitions"] == facts["style_definitions"]
    assert "objects" not in page["snapshot"]
    status, objects = post(
        running_server,
        "/api/docx-query",
        {
            "target": target,
            "operation": "snapshot",
            "limit": 1,
        },
    )
    assert status == 200 and "style_definitions" not in objects["snapshot"]
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    manuscript = snapshot(content, size=19, role="heading")
    paragraph = deepcopy(manuscript["objects"][0])
    paragraph.update(
        object_id="/word/document.xml#0.0",
        path=[0, 0],
        kind="paragraph",
        properties={"paragraph": {"outlineLevel": 2}},
    )
    manuscript["objects"][0]["evidence"] = {"paragraph_object_id": paragraph["object_id"]}
    manuscript["objects"].insert(0, paragraph)
    status, captured = post(
        running_server,
        "/api/docx-format",
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "snapshot": manuscript,
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
            "request_id": "unused-heading-check",
            "origin": {"surface": "user"},
        },
    )
    assert status == 200, checked
    finding = next(
        item
        for item in checked["template_comparison"]["findings"]
        if item["property_path"] == "run.fontSizePt"
    )
    assert (finding["observed"], finding["expected"], finding["verdict"]) == (
        19,
        13,
        "observed_difference",
    )
    assert finding["template_object_ids"] == ["/word/styles.xml#0.0"]
    font_finding = next(
        item
        for item in checked["template_comparison"]["findings"]
        if item["property_path"] == "run.fontFamily"
    )
    assert font_finding["expected"] == world["template"]["font_requirements"][0]["family"]


@pytest.mark.parametrize(
    "analyzer",
    [
        "docx-template-analyzer-1.0.0",
        "docx-template-analyzer-1.1.0",
        "docx-template-analyzer-1.2.0",
    ],
)
def test_historical_template_fonts_remain_readable_without_reinterpreting_styles(
    running_server, analyzer
):
    from research_file_workbench.journals.models import (
        WorldAnalysisError,
        validate_world_for_execution,
        world_version_id,
    )

    content = heading_template_content()
    payload = adopt_payload(content)
    payload["snapshot"] = heading_template_snapshot(content)
    status, current = post(running_server, "/api/template-world", payload)
    assert status == 200, current
    assert current["analyzer_version"] == "docx-template-analyzer-1.3.0"
    validate_world_for_execution(current)
    legacy = {
        key: deepcopy(value)
        for key, value in current.items()
        if key not in {"created_at", "version_ordinal"}
    }
    legacy["analyzer_version"] = analyzer
    legacy["template"]["font_requirements"] = []
    legacy["version_id"] = world_version_id(legacy)
    sources = {
        item["source_id"]: running_server.service.store.read_source(item["source_id"])
        for item in legacy["sources"]
    }
    retained = running_server.service.store.save_world(legacy, sources)
    assert running_server.service.store.get_world(legacy["version_id"]) == retained
    assert retained["template"]["font_requirements"] == []
    assert retained["version_id"] == legacy["version_id"]
    with pytest.raises(WorldAnalysisError, match="Template analyzer changed"):
        validate_world_for_execution(retained)
    corrupted_current = {**legacy, "analyzer_version": current["analyzer_version"]}
    corrupted_current["version_id"] = world_version_id(corrupted_current)
    with pytest.raises(WorldAnalysisError, match="Template font requirements differ"):
        running_server.service.store.save_world(corrupted_current, sources)


def test_new_import_and_capture_refuse_legacy_facts_without_relabelling_them(running_server):
    from research_file_workbench.projects.service import open_project

    content, world, project, request = setup_comparison(running_server)
    legacy = snapshot(content)
    legacy.pop("method_version")
    legacy.pop("style_definitions")
    payload = adopt_payload(content)
    payload["snapshot"] = legacy
    status, refused = post(running_server, "/api/template-world", payload)
    assert status == 400, refused
    status, refused = post(
        running_server,
        "/api/docx-format",
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "snapshot": legacy,
        },
    )
    assert status == 400, refused
    stored = open_project(running_server.service.project_root(project["project_id"]))
    stored.save_format_snapshot(project["baseline_id"], legacy)
    status, page = post(
        running_server,
        "/api/docx-query",
        {
            "target": {"project_id": project["project_id"], "baseline_id": project["baseline_id"]},
            "operation": "snapshot",
        },
    )
    assert status == 200 and page["snapshot"] == legacy
    status, refused = post(running_server, "/api/template-check", request)
    assert status == 400, refused
    assert running_server.service.store.get_binding(project["project_id"]) is None
    assert (
        running_server.service.store.get_world(world["version_id"])["template"] == world["template"]
    )


def test_retained_previous_snapshot_upgrades_from_its_exact_docx(running_server):
    _, _, project, request = setup_comparison(running_server)
    status, saved_check = post(running_server, "/api/template-check", request)
    assert status == 200, saved_check
    content = heading_template_content(
        '<w:style w:type="character" w:styleId="Emphasis"/>'
        '<w:style w:type="table" w:styleId="Grid"/>'
    )
    facts = heading_template_snapshot(content)
    for index, (style_id, style_type, effective_status) in enumerate(
        [("Emphasis", "character", "run"), ("Grid", "table", "declaration_only")], start=1
    ):
        facts["style_definitions"].append(
            {
                **facts["style_definitions"][0],
                "object_id": f"/word/styles.xml#0.{index}",
                "path": [0, index],
                "style_id": style_id,
                "name": style_id,
                "type": style_type,
                "role": "unknown",
                "role_basis": [],
                "properties": {"paragraph": {}, "run": {}, "script_usage": {}},
                "effective_status": effective_status,
            }
        )
    status, current = post(
        running_server, "/api/template-world", {**adopt_payload(content), "snapshot": facts}
    )
    assert status == 200, current

    previous_method = "docx-core-format-snapshot-1.2.0"
    previous_facts = {**facts, "method_version": previous_method}
    previous_bytes = encode_json_object(previous_facts).encode()
    previous_hash = sha256_bytes(previous_bytes)
    snapshot_id = f"source-{previous_hash}"
    old_world = {
        key: deepcopy(value)
        for key, value in current.items()
        if key not in {"created_at", "version_ordinal"}
    }
    old_world["reader_version"] = previous_method
    old_world["template"]["snapshot_source_id"] = snapshot_id
    store = running_server.service.store
    sources = {}
    for source in old_world["sources"]:
        if source["kind"] == "docx_format_snapshot":
            source.update(source_id=snapshot_id, sha256=previous_hash)
            sources[snapshot_id] = previous_bytes
        else:
            sources[source["source_id"]] = store.read_source(source["source_id"])
    old_world["version_id"] = world_version_id(old_world)
    retained = store.save_world(old_world, sources)
    version_id = retained["version_id"]
    project_id = project["project_id"]
    binding = store.bind_project(
        project_id,
        running_server.service.project_root(project_id).as_posix(),
        project["baseline_id"],
        version_id,
        expected_binding_id=saved_check["binding_id"],
        actor_id="local-operator",
        surface="browser",
    )
    bindings = store.list_bindings(project_id)
    checks = store.list_checks(project_id)

    status, prepared = post(
        running_server,
        "/api/template-prepare",
        {
            "project_id": project_id,
            "expected_baseline_id": project["baseline_id"],
            "retained_snapshot": {"world_version_id": version_id, "snapshot": facts},
        },
    )
    assert status == 200, prepared
    assert prepared["refreshed"] is True
    upgraded = prepared["world"]
    assert upgraded["version_id"] != version_id
    assert upgraded["reader_version"] == FORMAT_SNAPSHOT_METHOD_VERSION
    assert upgraded["analyzer_version"] == "docx-template-analyzer-1.3.0"
    assert prepared["binding"]["world_version_id"] == upgraded["version_id"]
    assert store.list_bindings(project_id)[: len(bindings)] == bindings
    assert len(store.list_bindings(project_id)) == len(bindings) + 1
    status, refused = post(
        running_server,
        "/api/template-check",
        {
            **request,
            "world_version_id": version_id,
            "expected_binding_id": binding["binding_id"],
            "request_id": "compare-with-old-snapshot",
        },
    )
    assert status == 400, refused

    status, page = post(
        running_server,
        "/api/docx-query",
        {"target": {"world_version_id": version_id}, "operation": "snapshot"},
    )
    assert status == 200 and page["snapshot"] == previous_facts, page
    status, source = _request(
        running_server, "GET", f"/api/template-source?world_version_id={version_id}"
    )
    assert status == 200 and base64.b64decode(source["content_base64"]) == content, source
    assert store.read_source(snapshot_id) == previous_bytes
    assert store.get_world(version_id) == retained
    assert store.list_checks(project_id) == checks


def test_candidate_prepare_uses_the_upgraded_world_without_rebinding(running_server):
    store = running_server.service.store
    with sqlite3.connect(store.database_path) as connection:
        connection.execute("DROP TABLE template_refresh")
    content = template_bytes(((11906, 16838, 1440, 2),))
    different = template_bytes(((11906, 16838, 1440, 3),))
    status, current = post(running_server, "/api/template-world", adopt_payload(different))
    assert status == 200, current
    legacy = retain_legacy_template_world(
        running_server, current, normalized=content, facts=snapshot(content)
    )
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    status, reference = post(
        running_server,
        "/api/docx-format",
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "snapshot": snapshot(content, size=12),
        },
    )
    assert status == 200, reference
    binding = running_server.service.store.bind_project(
        project["project_id"],
        running_server.service.project_root(project["project_id"]).as_posix(),
        project["baseline_id"],
        legacy["version_id"],
        expected_binding_id=None,
        actor_id="local-operator",
        surface="browser",
    )
    bindings = running_server.service.store.list_bindings(project["project_id"])

    prepared_request = {
        "project_id": project["project_id"],
        "expected_baseline_id": project["baseline_id"],
        "world_version_id": legacy["version_id"],
        "surface": "agent",
        "include_snapshot_reference": True,
    }
    status, refresh = post(running_server, "/api/template-prepare", prepared_request)
    assert status == 409, refresh
    assert refresh["code"] == "template_snapshot_recapture_required"
    assert refresh["world_version_id"] == legacy["version_id"]
    status, retained = _request(
        running_server,
        "GET",
        f"/api/template-source?world_version_id={refresh['world_version_id']}",
    )
    assert status == 200 and base64.b64decode(retained["content_base64"]) == content
    status, prepared = post(
        running_server,
        "/api/template-prepare",
        {
            **prepared_request,
            "retained_snapshot": {
                "world_version_id": legacy["version_id"],
                "snapshot": snapshot(content),
            },
        },
    )

    assert status == 200, prepared
    assert prepared["refreshed"] is True
    assert prepared["world"]["version_id"] != legacy["version_id"]
    assert prepared["world"]["reader_version"] == FORMAT_SNAPSHOT_METHOD_VERSION
    assert prepared["binding"] == binding
    assert prepared["snapshot_reference"] == {
        key: reference[key]
        for key in (
            "baseline_id",
            "source_sha256",
            "snapshot_artifact_version_id",
            "method_version",
        )
    }
    assert running_server.service.store.list_bindings(project["project_id"]) == bindings
    assert (
        running_server.service.store.get_world(legacy["version_id"])["reader_version"]
        == "docx-core-format-snapshot-1.2.0"
    )
    worlds = store.list_worlds()
    status, repeated = post(running_server, "/api/template-prepare", prepared_request)
    assert status == 200, repeated
    assert repeated == prepared
    assert store.list_worlds() == worlds
    assert store.list_bindings(project["project_id"]) == bindings


def test_legacy_snapshot_refuses_new_facts_from_a_different_docx(running_server):
    original = template_bytes(((11906, 16838, 1440, 2),))
    different = template_bytes(((11906, 16838, 1440, 3),))
    status, current = post(running_server, "/api/template-world", adopt_payload(original))
    assert status == 200, current
    legacy = retain_legacy_template_world(
        running_server,
        current,
        facts=snapshot(different),
        normalized=different,
    )
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(original, "draft.docx")}
    )
    assert status == 200, project
    binding = running_server.service.store.bind_project(
        project["project_id"],
        running_server.service.project_root(project["project_id"]).as_posix(),
        project["baseline_id"],
        legacy["version_id"],
        expected_binding_id=None,
        actor_id="local-operator",
        surface="browser",
    )

    status, refused = post(
        running_server,
        "/api/template-prepare",
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "world_version_id": legacy["version_id"],
            "include_snapshot_reference": True,
            "retained_snapshot": {
                "world_version_id": legacy["version_id"],
                "snapshot": snapshot(original),
            },
        },
    )

    assert status == 409, refused
    assert refused["code"] == "template_snapshot_recapture_invalid"
    assert running_server.service.store.get_binding(project["project_id"]) == binding


def test_legacy_snapshot_refuses_capture_for_another_world(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, current = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200, current
    legacy = retain_legacy_template_world(running_server, current, facts=snapshot(content, size=12))
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project

    status, refused = post(
        running_server,
        "/api/template-prepare",
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "world_version_id": legacy["version_id"],
            "include_snapshot_reference": True,
            "retained_snapshot": {
                "world_version_id": current["version_id"],
                "snapshot": snapshot(content),
            },
        },
    )

    assert status == 409, refused
    assert refused["code"] == "template_selection_changed"
    assert running_server.service.store.get_binding(project["project_id"]) is None


def test_only_the_known_previous_snapshot_method_is_eligible_for_recapture(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, current = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200, current
    legacy = retain_legacy_template_world(
        running_server, current, method="docx-core-format-snapshot-1.1.0"
    )
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project

    assert template_preparation(legacy)["state"] == "unsupported"
    status, refused = post(
        running_server,
        "/api/template-prepare",
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "world_version_id": legacy["version_id"],
            "include_snapshot_reference": True,
        },
    )

    assert status == 409, refused
    assert refused["code"] == "template_snapshot_outdated"


@pytest.mark.parametrize("invalid", ["style_locator", "table_link", "table_position"])
def test_snapshot_rejects_invalid_style_and_table_context_locators(running_server, invalid):
    content = heading_template_content()
    payload = adopt_payload(content)
    facts = heading_template_snapshot(content)
    payload["snapshot"] = facts
    if invalid == "style_locator":
        facts["style_definitions"][0]["object_id"] = "/word/styles.xml#0.99"
    else:
        table = deepcopy(facts["objects"][0])
        table.update(object_id="/word/document.xml#0.5", path=[0, 5], kind="table")
        facts["objects"].append(table)
        facts["objects"][0]["table_context"] = {
            "table_object_id": "/word/document.xml#0.999"
            if invalid == "table_link"
            else table["object_id"],
            "row_index": 3,
            "row_count": 2,
            "conditions": ["firstRow"],
        }
    status, refused = post(running_server, "/api/template-world", payload)
    assert status == 400, refused


def test_snapshot_node_address_is_bound_to_exact_source_and_part():
    from research_file_workbench.docx.package_query import (
        WORKBENCH_XML_CHILD_PATH_VERSION,
        XML_ELEMENT_PATH_VERSION,
    )
    from research_file_workbench.journals.models import WorldAnalysisError
    from research_file_workbench.journals.template_models import validate_snapshot

    content = template_bytes(((11906, 16838, 1440, 2),))
    facts = snapshot(content)
    address = {
        "version": XML_ELEMENT_PATH_VERSION,
        "source_sha256": sha256_bytes(content),
        "part": "/word/document.xml",
        "path": [0, 0, 0],
    }
    facts["objects"][0]["node_address"] = address
    validate_snapshot(facts, content, require_current=True)

    facts["objects"][0]["node_address"] = {
        **address,
        "version": WORKBENCH_XML_CHILD_PATH_VERSION,
    }
    with pytest.raises(WorldAnalysisError, match="invalid node address"):
        validate_snapshot(facts, content, require_current=True)

    facts["objects"][0]["node_address"] = {**address, "part": "/[Content_Types].xml"}
    with pytest.raises(WorldAnalysisError, match="differs from its snapshot part"):
        validate_snapshot(facts, content, require_current=True)


def test_prepare_explicit_template_does_not_mutate_an_unbound_project(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, world = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200, world
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    worlds_before = running_server.service.store.list_worlds()

    prepared = prepare(running_server.service, project, world_version_id=world["version_id"])

    assert prepared["world"]["version_id"] == world["version_id"]
    assert prepared["binding"] is None
    assert prepared["refreshed"] is False
    assert running_server.service.store.list_bindings(project["project_id"]) == []
    assert running_server.service.store.list_worlds() == worlds_before
    assert (
        running_server.service.project(project["project_id"])["baseline_id"]
        == project["baseline_id"]
    )


def test_prepare_without_binding_requires_an_explicit_template(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project

    with pytest.raises(TemplatePreparationError) as refused:
        prepare(running_server.service, project)

    assert (refused.value.code, refused.value.action) == (
        "template_selection_required",
        "select_template",
    )
    assert running_server.service.store.get_binding(project["project_id"]) is None


def test_prepare_explicit_other_template_leaves_the_project_binding_unchanged(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, original = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200, original
    status, ijam = post(
        running_server,
        "/api/template-world",
        adopt_payload(content, journal_id="ijam", journal_name="IJAM"),
    )
    assert status == 200, ijam
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    binding = running_server.service.store.bind_project(
        project["project_id"],
        running_server.service.project_root(project["project_id"]).as_posix(),
        project["baseline_id"],
        original["version_id"],
        expected_binding_id=None,
        actor_id="local-operator",
        surface="browser",
    )

    prepared = prepare(running_server.service, project, world_version_id=ijam["version_id"])

    assert prepared["world"]["version_id"] == ijam["version_id"]
    assert prepared["binding"]["binding_id"] == binding["binding_id"]
    assert prepared["refreshed"] is False
    assert running_server.service.store.list_bindings(project["project_id"]) == [binding]
    assert len(running_server.service.state()["projects"]) == 1


def test_prepare_implicit_template_is_repeatable_without_appending_bindings(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, world = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200, world
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    binding = running_server.service.store.bind_project(
        project["project_id"],
        running_server.service.project_root(project["project_id"]).as_posix(),
        project["baseline_id"],
        world["version_id"],
        expected_binding_id=None,
        actor_id="local-operator",
        surface="browser",
    )
    worlds_before = running_server.service.store.list_worlds()

    first = prepare(running_server.service, project)
    second = prepare(running_server.service, project)

    assert first == second
    assert first["world"]["version_id"] == world["version_id"]
    assert first["binding"]["binding_id"] == binding["binding_id"]
    assert first["refreshed"] is False
    assert running_server.service.store.list_bindings(project["project_id"]) == [binding]
    assert running_server.service.store.list_worlds() == worlds_before


def test_prepare_refreshes_historical_template_from_the_same_retained_sources(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    payload = adopt_payload(content)
    payload["snapshot"] = four_group_snapshot(content)
    payload["sources"] = [
        {
            "name": "requirements.json",
            "kind": "rule_component_json",
            "content_base64": base64.b64encode(
                component_bytes({"columns": 2}, journal_id="template-test")
            ).decode(),
        }
    ]
    status, current = post(running_server, "/api/template-world", payload)
    assert status == 200, current
    object_rules = [rule for rule in current["rules"] if rule["property"] == "object_format"]
    assert len(object_rules) == 4
    assert len(current["template"]["font_requirements"]) == 1
    assert template_preparation(current) == {
        "state": "ready",
        "reason": None,
        "analyzer_version": "docx-template-analyzer-1.3.0",
        "current_analyzer_version": "docx-template-analyzer-1.3.0",
        "snapshot_method": FORMAT_SNAPSHOT_METHOD_VERSION,
        "current_snapshot_method": FORMAT_SNAPSHOT_METHOD_VERSION,
        "refreshable": False,
    }
    component_rule = next(rule for rule in current["rules"] if rule["property"] == "columns")
    revised = revise_rule(
        current,
        component_rule["rule_id"],
        1,
        "Retain the operator requirement across the analyzer refresh.",
        "local-operator",
    )
    legacy = {
        key: deepcopy(value)
        for key, value in revised.items()
        if key not in {"created_at", "version_ordinal"}
    }
    legacy["analyzer_version"] = "docx-template-analyzer-1.2.0"
    legacy["version_id"] = world_version_id(legacy)
    assert template_preparation(legacy)["state"] == "pending_refresh"
    assert template_preparation(legacy)["refreshable"] is True
    sources = {
        source["source_id"]: running_server.service.store.read_source(source["source_id"])
        for source in legacy["sources"]
    }
    running_server.service.store.save_world(legacy, sources)
    summary = next(
        world
        for world in running_server.service.state()["worlds"]
        if world["version_id"] == legacy["version_id"]
    )
    assert summary["template_preparation"]["state"] == "pending_refresh"
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    old_binding = running_server.service.store.bind_project(
        project["project_id"],
        running_server.service.project_root(project["project_id"]).as_posix(),
        project["baseline_id"],
        legacy["version_id"],
        expected_binding_id=None,
        actor_id="local-operator",
        surface="browser",
    )

    prepared = prepare(running_server.service, project, surface="agent")

    assert prepared["refreshed"] is True
    refreshed = prepared["world"]
    assert refreshed["version_id"] != legacy["version_id"]
    assert refreshed["analyzer_version"] == "docx-template-analyzer-1.3.0"
    assert len([rule for rule in refreshed["rules"] if rule["property"] == "object_format"]) == 4
    assert len(refreshed["template"]["font_requirements"]) == 1
    assert refreshed["manual_decisions"] == legacy["manual_decisions"]
    refreshed_rule = next(rule for rule in refreshed["rules"] if rule["property"] == "columns")
    assert refreshed_rule["expected"] == 1
    assert refreshed_rule["basis_status"] == "confirmed"
    assert refreshed_rule["confirmation_method"] == "human_decision"
    assert refreshed_rule["resolution"]["base_version_id"] == current["version_id"]
    assert refreshed_rule["resolution"]["previous_basis_status"] == "candidate"
    assert refreshed_rule["resolution"]["previous_expected"] == 2
    assert {source["source_id"] for source in refreshed["sources"]} == {
        source["source_id"] for source in legacy["sources"]
    }
    assert (
        running_server.service.store.get_world(legacy["version_id"])["version_id"]
        == legacy["version_id"]
    )
    bindings = running_server.service.store.list_bindings(project["project_id"])
    assert [binding["binding_id"] for binding in bindings] == [
        old_binding["binding_id"],
        prepared["binding"]["binding_id"],
    ]
    assert prepared["binding"]["baseline_id"] == project["baseline_id"]
    assert prepared["binding"]["actor_id"] == "application-agent"
    assert prepared["binding"]["surface"] == "agent"

    repeated = prepare(running_server.service, project)
    assert repeated["world"]["version_id"] == refreshed["version_id"]
    assert repeated["binding"]["binding_id"] == prepared["binding"]["binding_id"]
    assert repeated["refreshed"] is False
    assert running_server.service.store.list_bindings(project["project_id"]) == bindings


def test_prepare_reports_missing_retained_template_source(running_server, monkeypatch):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, retained = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200, retained
    world = running_server.service.store.get_world(retained["version_id"])
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    monkeypatch.setattr(
        running_server.service.store, "get_world_metadata", lambda version_id: world
    )

    def missing(source_id):
        raise WorldStoreError("source is missing")

    monkeypatch.setattr(running_server.service.store, "read_source", missing)
    with pytest.raises(TemplatePreparationError) as refused:
        prepare(running_server.service, project, world_version_id=world["version_id"])

    assert (refused.value.code, refused.value.action) == (
        "template_source_unavailable",
        "recapture_template",
    )
    assert "Template Test" in str(refused.value)
    assert running_server.service.store.get_binding(project["project_id"]) is None


def test_prepare_reports_corrupt_retained_template_source(running_server, monkeypatch):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, retained = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200, retained
    world = running_server.service.store.get_world(retained["version_id"])
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    monkeypatch.setattr(
        running_server.service.store, "get_world_metadata", lambda version_id: world
    )
    monkeypatch.setattr(running_server.service.store, "read_source", lambda source_id: b"corrupt")

    with pytest.raises(TemplatePreparationError) as refused:
        prepare(running_server.service, project, world_version_id=world["version_id"])

    assert (refused.value.code, refused.value.action) == (
        "template_source_unavailable",
        "recapture_template",
    )
    assert "Template Test" in str(refused.value)
    assert running_server.service.store.get_binding(project["project_id"]) is None


def test_prepare_reports_damaged_persisted_template_source_with_its_name(running_server):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, retained = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200, retained
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    with sqlite3.connect(running_server.service.store.database_path) as connection:
        connection.execute(
            "UPDATE source SET content=? WHERE source_id IN (SELECT source_id FROM source LIMIT 1)",
            (b"damaged retained template",),
        )

    with pytest.raises(TemplatePreparationError) as refused:
        prepare(
            running_server.service,
            project,
            world_version_id=retained["version_id"],
        )

    assert (refused.value.code, refused.value.action) == (
        "template_source_unavailable",
        "recapture_template",
    )
    assert "Template Test" in str(refused.value)
    assert running_server.service.store.get_binding(project["project_id"]) is None


def test_prepare_rebind_refusal_names_the_template_and_request_origin(running_server, monkeypatch):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, original = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200, original
    status, refreshed = post(
        running_server,
        "/api/template-world",
        adopt_payload(template_bytes(((11906, 16838, 1440, 1),))),
    )
    assert status == 200, refreshed
    status, project = post(
        running_server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    binding = running_server.service.store.bind_project(
        project["project_id"],
        running_server.service.project_root(project["project_id"]).as_posix(),
        project["baseline_id"],
        original["version_id"],
        expected_binding_id=None,
        actor_id="local-operator",
        surface="browser",
    )
    monkeypatch.setattr(
        "research_file_workbench.workbench.template_service._prepared_world",
        lambda service, version_id, retained_snapshot: refreshed,
    )

    def conflict(*args, **kwargs):
        raise BindingConflictError("binding changed")

    monkeypatch.setattr(running_server.service.store, "bind_project", conflict)
    with pytest.raises(BindingConflictError) as refused:
        prepare(running_server.service, project, surface="agent")

    assert "Template Test" in str(refused.value)
    assert "agent request" in str(refused.value)
    assert running_server.service.store.get_binding(project["project_id"]) == binding


def test_template_discovery_summary_does_not_read_retained_sources(running_server, monkeypatch):
    content = template_bytes(((11906, 16838, 1440, 2),))
    status, world = post(running_server, "/api/template-world", adopt_payload(content))
    assert status == 200, world

    def missing(source_id):
        raise WorldStoreError("source is missing")

    monkeypatch.setattr(running_server.service.store, "read_source", missing)
    state = running_server.service.state()

    assert state["worlds"][0]["version_id"] == world["version_id"]
    assert state["worlds"][0]["template_preparation"]["state"] == "ready"


def test_non_template_world_summary_has_no_preparation_projection(running_server):
    status, world = post(
        running_server,
        "/api/worlds",
        {
            "journal_id": "guide-test",
            "journal_name": "Guide Test",
            "article_type": "research_article",
            "stage": "initial_submission",
            "language": "en",
            "sources": [
                {
                    "name": "guide.txt",
                    "kind": "guide_text",
                    "content_base64": base64.b64encode(b"Guidance for authors.").decode(),
                }
            ],
        },
    )
    assert status == 200, world

    summary = next(
        item
        for item in running_server.service.state()["worlds"]
        if item["version_id"] == world["version_id"]
    )
    assert "template_preparation" not in summary
