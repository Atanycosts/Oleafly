"""Exercise retained manuscript capabilities through the desktop's HTTP contract."""

import base64
import json
import shutil
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlencode

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import write_json_object
from research_file_workbench.projects.service import open_project
from research_file_workbench.workbench.manuscripts import _source_filename
from tests.journals.test_analysis import template_bytes
from tests.workbench.test_server import _request, _world_payload


def upload(content):
    return {"content_base64": base64.b64encode(content).decode("ascii")}


def import_project(server, content=None):
    token = server.session_token
    status, project = _request(
        server,
        "POST",
        "/api/projects",
        {"name": "论文工作稿", "filename": "稿件.docx", **upload(content or template_bytes())},
        token,
    )
    assert status == 200, project
    return project


def selection(project, **changes):
    query = {
        "region": None,
        "object_type": None,
        "object_id": None,
        "page_number": None,
        "page_size": 1,
        "cursor": None,
    }
    query.update(changes)
    return {
        "project_id": project["project_id"],
        "baseline_id": None,
        "render_bundle_id": None,
        "query": query,
    }


def test_catalog_query_continuation_recovery_and_history(running_server):
    fixture = (
        Path(__file__).resolve().parents[2]
        / "tests/fixtures/docx/normal/s1-figures-tables/s1-figures-tables.docx"
    )
    project = import_project(running_server, fixture.read_bytes())
    query = urlencode({"project_id": project["project_id"], "baseline_id": "current"})
    status, workspace = _request(running_server, "GET", "/api/manuscript?" + query)
    assert status == 200
    assert workspace["reads"] == []
    assert workspace["catalog"]["status"] == "catalog_only"
    assert len(workspace["catalog"]["items"]) >= 2
    first = selection(project)
    status, response = _request(
        running_server, "POST", "/api/read", first, running_server.session_token
    )
    assert status == 200, response
    assert len(response["items"]) == 1
    cursor = response["pagination"]["next_cursor"]
    assert cursor
    status, continued = _request(
        running_server,
        "POST",
        "/api/read",
        selection(project, cursor=cursor),
        running_server.session_token,
    )
    assert status == 200, continued
    assert response["items"][0]["object_id"] != continued["items"][0]["object_id"]
    query = urlencode(
        {
            "project_id": project["project_id"],
            "read_record_id": response["delivery"]["read_record_id"],
        }
    )
    status, recovered = _request(running_server, "GET", "/api/read?" + query)
    assert status == 200 and recovered == response
    status, history = _request(
        running_server, "GET", "/api/history?" + urlencode({"project_id": project["project_id"]})
    )
    assert status == 200 and history["checks"] == [] and history["bindings"] == []
    assert len(history["reads"]) == 2


def test_baseline_update_is_idempotent_and_preserves_history(running_server):
    project = import_project(running_server)
    token = running_server.session_token
    _, world = _request(running_server, "POST", "/api/worlds", _world_payload(), token)
    _request(
        running_server,
        "POST",
        "/api/bind",
        {
            "project_id": project["project_id"],
            "world_version_id": world["version_id"],
            "expected_binding_id": None,
        },
        token,
    )
    _, check = _request(
        running_server, "POST", "/api/check", {"project_id": project["project_id"]}, token
    )
    change = {
        "project_id": project["project_id"],
        "expected_baseline_id": project["baseline_id"],
        "filename": "修订稿.docx",
        "reason": "完成作者修订",
        "request_id": "revision-one",
        **upload(template_bytes()),
    }
    status, result = _request(running_server, "POST", "/api/baseline", change, token)
    assert status == 200 and result["status"] == "APPLIED"
    assert result["result_baseline_id"] != project["baseline_id"]
    assert _request(running_server, "POST", "/api/baseline", change, token) == (200, result)
    conflicting = {**change, "request_id": "revision-conflict"}
    assert _request(running_server, "POST", "/api/baseline", conflicting, token)[0] == 409
    _, historical = _request(
        running_server, "GET", "/api/check?" + urlencode({"check_id": check["check_id"]})
    )
    assert historical["validity"] == "STALE"
    assert historical["rule_results"] == check["rule_results"]
    store = open_project(running_server.service.project_root(project["project_id"]))
    assert len(store.list_baselines()) == 2


@pytest.mark.parametrize("refusal", ["BASELINE_CONFLICT", "IDEMPOTENCY_CONFLICT", "REJECTED"])
def test_baseline_refusal_preserves_exact_request_result_over_http(running_server, refusal):
    project = import_project(running_server)
    token = running_server.session_token
    submitted = {
        "project_id": project["project_id"],
        "expected_baseline_id": project["baseline_id"],
        "filename": "revision.docx",
        "reason": "Keep the confirmed source revision",
        "request_id": "already-applied",
        **upload(template_bytes()),
    }
    http, applied = _request(running_server, "POST", "/api/baseline", submitted, token)
    assert http == 200 and applied["status"] == "APPLIED"
    refused = {**submitted, "request_id": "confirmed-refusal"}
    if refusal == "IDEMPOTENCY_CONFLICT":
        refused.update(request_id=submitted["request_id"], **upload(b"different bytes"))
    elif refusal == "REJECTED":
        refused.update(expected_baseline_id=applied["result_baseline_id"], **upload(b"not a DOCX"))
    for _attempt in range(2):
        http, result = _request(running_server, "POST", "/api/baseline", refused, token)
        assert http == (409 if refusal == "BASELINE_CONFLICT" else 400)
        assert result["status"] == refusal
        assert result["request_id"] == refused["request_id"]
        assert len(result["request_digest"]) == 64
        assert result["result_baseline_id"] is None
        assert result["error"]
        store = open_project(running_server.service.project_root(project["project_id"]))
        retained = store.get_request("local-operator", refused["request_id"])
        if refusal == "IDEMPOTENCY_CONFLICT":
            assert result["original_result_baseline_id"] == applied["result_baseline_id"]
            assert result["request_digest"] != retained["result"]["request_digest"]
            assert result["request_digest"] == retained["conflict_attempts"][-1]["request_digest"]
        else:
            assert {key: value for key, value in result.items() if key != "error"} == retained[
                "result"
            ]
        assert len(store.list_baselines()) == 2
        assert store.info()["current_baseline_id"] == applied["result_baseline_id"]


def test_manuscript_source_returns_exact_current_and_historical_retained_bytes(running_server):
    original = template_bytes()
    revised = template_bytes(((11906, 16838, 1440, 2),))
    project = import_project(running_server, original)
    old_baseline_id = project["baseline_id"]
    update = {
        "project_id": project["project_id"],
        "expected_baseline_id": old_baseline_id,
        "filename": "修订稿.docx",
        "reason": "保留第二版原始 DOCX",
        "request_id": "source-endpoint-revision",
        **upload(revised),
    }
    status, applied = _request(
        running_server, "POST", "/api/baseline", update, running_server.session_token
    )
    assert status == 200 and applied["status"] == "APPLIED"
    new_baseline_id = applied["result_baseline_id"]
    shutil.rmtree(running_server.service.root / "inputs")

    for baseline_id, content, filename in (
        (old_baseline_id, original, "manuscript.docx"),
        (new_baseline_id, revised, "修订稿.docx"),
    ):
        query = urlencode({"project_id": project["project_id"], "baseline_id": baseline_id})
        status, source = _request(running_server, "GET", "/api/manuscript-source?" + query)
        assert status == 200, source
        assert source == {
            "project_id": project["project_id"],
            "baseline_id": baseline_id,
            "source_sha256": sha256_bytes(content),
            "filename": filename,
            "content_base64": base64.b64encode(content).decode("ascii"),
        }
        assert source == running_server.service.manuscript_source(
            project["project_id"], baseline_id
        )

    store = open_project(running_server.service.project_root(project["project_id"]))
    assert store.list_reads() == []


def test_manuscript_source_rejects_missing_projects_and_foreign_baselines(running_server):
    project = import_project(running_server)
    other = import_project(running_server)
    for project_id, baseline_id, expected_status in (
        (project["project_id"], other["baseline_id"], 500),
        (project["project_id"], "baseline-missing", 500),
        (project["project_id"], "current", 500),
        ("project-missing", project["baseline_id"], 400),
    ):
        query = urlencode({"project_id": project_id, "baseline_id": baseline_id})
        status, result = _request(running_server, "GET", "/api/manuscript-source?" + query)
        assert status == expected_status
        assert set(result) == {"error"}
        assert running_server.service.root.as_posix() not in result["error"]


def test_manuscript_source_filename_uses_cross_platform_basename_and_project_fallback(
    tmp_path: Path,
):
    write_json_object(
        tmp_path / "display.json", {"name": "论文 / 修订版", "filename": "display.docx"}
    )
    assert (
        _source_filename(tmp_path, {"source_path": r"C:\author\private\source.DOCX"})
        == "source.DOCX"
    )
    assert (
        _source_filename(tmp_path, {"source_path": "/author/private/source.docx"}) == "source.docx"
    )
    assert _source_filename(tmp_path, {"source_path": "artifact-only"}) == "论文 - 修订版.docx"


@pytest.mark.parametrize(
    "changes",
    [
        {"page_size": True},
        {"page_number": True},
        {"region": []},
        {"object_type": "unknown"},
        {"cursor": "not-a-cursor"},
    ],
)
def test_invalid_read_is_rejected_without_persisted_response(running_server, changes):
    project = import_project(running_server)
    status, response = _request(
        running_server,
        "POST",
        "/api/read",
        selection(project, **changes),
        running_server.session_token,
    )
    assert status == 400 and set(response) == {"error"}
    store = open_project(running_server.service.project_root(project["project_id"]))
    assert store.list_reads() == []


@pytest.mark.parametrize(
    "route",
    [
        "/api/manuscript",
        "/api/manuscript-source",
        "/api/derived-renders",
        "/api/history",
        "/api/read",
        "/api/render",
    ],
)
def test_workspace_get_parameters_are_exact(running_server, route):
    assert _request(running_server, "GET", route + "?path=C:/author/file.docx")[0] == 400


def bundle_upload(inputs, project):
    index = json.loads((inputs / "index.json").read_bytes())
    return {
        "project_id": project["project_id"],
        "baseline_id": project["baseline_id"],
        "reason": "独立页面证据",
        "render_record": upload((inputs / "render.json").read_bytes()),
        "page_index": upload((inputs / "index.json").read_bytes()),
        "pdf": upload((inputs / "source.pdf").read_bytes()),
        "pages": [
            {"page_number": item["page_number"], **upload(Path(item["path"]).read_bytes())}
            for item in index["pages"]
        ],
        "document_annotation": upload((inputs / "document-annotation.json").read_bytes()),
        "page_evidence": upload((inputs / "page-evidence.json").read_bytes()),
    }


def test_captured_page_bundle_preserves_bytes_and_supports_reviewed_queries(
    running_server, rendered_project
):
    _, _, source, inputs, _ = rendered_project
    project = import_project(running_server, source.read_bytes())
    payload = bundle_upload(inputs, project)
    # Uploaded paths are historic labels: they must not cause any host filesystem read.
    original = json.loads((inputs / "render.json").read_bytes())
    original["output_path"] = "C:/nonexistent-author/never-open.pdf"
    payload["render_record"] = upload(json.dumps(original).encode())
    token = running_server.session_token
    status, bundle = _request(running_server, "POST", "/api/render-bundle", payload, token)
    assert status == 200, bundle
    assert bundle["manifest"]["mapping_status"] == "reviewed"
    query = selection(project, object_type="image", page_number=1, page_size=10)
    query["render_bundle_id"] = bundle["bundle_id"]
    status, response = _request(running_server, "POST", "/api/read", query, token)
    assert status == 200 and len(response["items"]) == 2
    query_string = urlencode(
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "bundle_id": bundle["bundle_id"],
            "role": "pdf",
            "page_number": "none",
        }
    )
    connection = HTTPConnection(*running_server.server_address, timeout=10)
    connection.request("GET", "/api/render?" + query_string)
    result = connection.getresponse()
    assert result.status == 200
    assert result.getheader("Content-Type") == "application/pdf"
    assert result.read() == (inputs / "source.pdf").read_bytes()
    connection.close()
    assert _request(running_server, "POST", "/api/render-bundle", payload, token) == (200, bundle)


def test_duplicate_page_upload_cannot_publish_partial_bundle(running_server, rendered_project):
    _, _, source, inputs, _ = rendered_project
    project = import_project(running_server, source.read_bytes())
    payload = bundle_upload(inputs, project)
    payload["pages"].append(payload["pages"][0])
    status, result = _request(
        running_server, "POST", "/api/render-bundle", payload, running_server.session_token
    )
    assert status == 400 and set(result) == {"error"}
    assert (
        open_project(
            running_server.service.project_root(project["project_id"])
        ).list_render_bundles()
        == []
    )


def test_read_requires_session_and_rejects_post_query_fields(running_server):
    project = import_project(running_server)
    assert _request(running_server, "POST", "/api/read", selection(project))[0] == 403
    assert (
        _request(
            running_server,
            "POST",
            "/api/read?extra=value",
            selection(project),
            running_server.session_token,
        )[0]
        == 400
    )
