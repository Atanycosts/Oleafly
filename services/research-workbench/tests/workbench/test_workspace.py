"""Exercise retained manuscript capabilities through the desktop's HTTP contract."""

import base64
import json
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlencode

import pytest

from research_file_workbench.projects.service import open_project
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


@pytest.mark.parametrize("route", ["/api/manuscript", "/api/history", "/api/read", "/api/render"])
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
