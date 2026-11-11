"""HTTP integration checks for the local journal-world workbench."""

import base64
import json
import socket
import struct
import subprocess
import sys
import threading
from http.client import HTTPConnection
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import pymupdf
import pytest

from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.journals.store import WorldStoreError
from research_file_workbench.projects.models import BaselineConflictError
from research_file_workbench.projects.render_service import register_render_bytes
from research_file_workbench.projects.service import open_project
from research_file_workbench.workbench.server import WorkbenchHttpServer
from research_file_workbench.workbench.service import WorkbenchService
from tests.journals.test_analysis import template_bytes
from tests.journals.test_components import component


def _request(server: WorkbenchHttpServer, method: str, path: str, payload=None, token=None):
    connection = HTTPConnection(*server.server_address, timeout=10)
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers.update({"Content-Type": "application/json", "Content-Length": str(len(body))})
    if token is not None:
        headers["X-RFW-Token"] = token
    connection.request(method, path, body=body, headers=headers)
    response = connection.getresponse()
    content = response.read()
    connection.close()
    return response.status, json.loads(content.decode("utf-8"))


def _binary_request(server: WorkbenchHttpServer, path: str):
    connection = HTTPConnection(*server.server_address, timeout=10)
    connection.request("GET", path, headers={"Accept": "image/png"})
    response = connection.getresponse()
    content = response.read()
    content_type = response.getheader("Content-Type")
    connection.close()
    return response.status, content_type, content


@pytest.fixture
def running_server(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    server = WorkbenchHttpServer(("127.0.0.1", 0), service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _world_payload():
    return {
        "journal_id": "journal-test",
        "journal_name": "Test Journal",
        "article_type": "research_article",
        "stage": "initial_submission",
        "language": "en",
        "sources": [
            {
                "name": "guide.txt",
                "kind": "guide_text",
                "content_base64": base64.b64encode(
                    b"All manuscript pages must use A4 paper."
                ).decode("ascii"),
            }
        ],
    }


def test_session_and_static_ui_are_available(running_server: WorkbenchHttpServer):
    status, session = _request(running_server, "GET", "/api/session")
    assert status == 200
    assert isinstance(session["token"], str)
    connection = HTTPConnection(*running_server.server_address, timeout=10)
    connection.request("GET", "/")
    response = connection.getresponse()
    body = response.read().decode("utf-8")
    connection.close()
    assert response.status == 200
    assert "期刊" in body


def test_world_import_requires_session_and_persists_version(running_server):
    status, denied = _request(running_server, "POST", "/api/worlds", _world_payload(), "wrong")
    assert status == 403
    assert "error" in denied
    _, session = _request(running_server, "GET", "/api/session")
    status, world = _request(
        running_server, "POST", "/api/worlds", _world_payload(), session["token"]
    )
    assert status == 200
    assert world["version_id"].startswith("world-")
    status, state = _request(running_server, "GET", "/api/state")
    assert status == 200
    assert state["worlds"][0]["version_id"] == world["version_id"]


def test_api_rejects_path_traversal_and_returns_json_error(running_server):
    connection = HTTPConnection(*running_server.server_address, timeout=10)
    connection.request("GET", "/../pyproject.toml")
    response = connection.getresponse()
    body = response.read()
    connection.close()
    assert response.status == 404
    assert "error" in json.loads(body)


@pytest.mark.parametrize(
    "path",
    [
        "/api/session?unexpected=value",
        "/api/state?unexpected=value",
        "/api/world?version_id=missing&unexpected=value",
        "/api/check?check_id=missing&unexpected=value",
        "/api/diff?from_version=a&to_version=b&unexpected=value",
    ],
)
def test_get_rejects_unknown_query_fields(running_server, path):
    status, result = _request(running_server, "GET", path)
    assert status == 400
    assert set(result) == {"error"}


def test_get_rejects_duplicate_query_fields(running_server):
    status, result = _request(running_server, "GET", "/api/state?unexpected=a&unexpected=b")
    assert status == 400
    assert set(result) == {"error"}


@pytest.mark.parametrize("method", ["PUT", "DELETE", "OPTIONS", "PATCH"])
def test_unsupported_methods_return_json_405(running_server, method):
    connection = HTTPConnection(*running_server.server_address, timeout=5)
    connection.request(method, "/", headers={"Accept": "application/json"})
    response = connection.getresponse()
    body = json.loads(response.read())
    connection.close()
    assert response.status == 405
    assert response.getheader("Allow") == "GET, POST"
    assert set(body) == {"error"}


def test_internal_library_error_returns_500_without_internal_text(running_server, monkeypatch):
    def fail():
        raise WorldStoreError("C:/private/library/worlds.sqlite3 secret")

    monkeypatch.setattr(running_server.service, "state", fail)
    status, result = _request(running_server, "GET", "/api/state")
    assert status == 500
    assert set(result) == {"error"}
    assert "private" not in result["error"]


def test_baseline_conflict_returns_409(running_server, monkeypatch):
    _, session = _request(running_server, "GET", "/api/session")

    def fail(*args, **kwargs):
        raise BaselineConflictError("internal baseline identity")

    monkeypatch.setattr(running_server.service, "bind", fail)
    status, result = _request(
        running_server,
        "POST",
        "/api/bind",
        {
            "project_id": "project-test",
            "world_version_id": "world-test",
            "expected_binding_id": None,
        },
        session["token"],
    )
    assert status == 409
    assert set(result) == {"error"}
    assert "internal" not in result["error"]


def _guide_pdf_world_payload():
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((50, 100), "All manuscript pages must use A4 paper.", fontsize=10.0)
    payload = document.tobytes()
    document.close()
    return {
        "journal_id": "journal-test",
        "journal_name": "Test Journal",
        "article_type": "research_article",
        "stage": "initial_submission",
        "language": "en",
        "sources": [
            {
                "name": "guide.pdf",
                "kind": "guide_pdf",
                "content_base64": base64.b64encode(payload).decode("ascii"),
            }
        ],
    }


def test_source_page_preview_serves_pdf_and_refuses_invalid_targets(running_server):
    _, session = _request(running_server, "GET", "/api/session")
    token = session["token"]
    status, world = _request(
        running_server, "POST", "/api/worlds", _guide_pdf_world_payload(), token
    )
    assert status == 200, world
    pdf_source = world["sources"][0]["source_id"]
    status, page = _request(
        running_server,
        "GET",
        f"/api/source-page?version_id={world['version_id']}&source_id={pdf_source}&page=1",
        None,
        token,
    )
    assert status == 200, page
    assert page["page"] == 1 and page["page_count"] == 1
    assert page["width_pt"] > 0 and page["dpi"] == 110
    assert len(page["png_base64"]) > 100

    status, text_world = _request(running_server, "POST", "/api/worlds", _world_payload(), token)
    assert status == 200
    text_source = text_world["sources"][0]["source_id"]
    base = f"/api/source-page?version_id={text_world['version_id']}&source_id={text_source}&page=1"
    status, body = _request(running_server, "GET", base, None, token)
    assert status == 400 and "error" in body  # non-PDF source
    status, body = _request(
        running_server,
        "GET",
        f"/api/source-page?version_id={text_world['version_id']}&source_id=source-absent&page=1",
        None,
        token,
    )
    assert status == 400 and "error" in body  # foreign source
    status, body = _request(
        running_server,
        "GET",
        f"/api/source-page?version_id={world['version_id']}&source_id={pdf_source}&page=9",
        None,
        token,
    )
    assert status == 400 and "error" in body  # page out of range


def test_http_user_flow_uses_display_name_and_actual_filename(running_server):
    _, session = _request(running_server, "GET", "/api/session")
    token = session["token"]
    assert session["contract_version"] == "journal-http-1.7.0"
    assert len(session["asset_version"]) == 64
    status, world = _request(running_server, "POST", "/api/worlds", _world_payload(), token)
    assert status == 200
    status, project = _request(
        running_server,
        "POST",
        "/api/projects",
        {
            "name": "中文论文展示名",
            "filename": "source.DOCX",
            "content_base64": base64.b64encode(template_bytes()).decode(),
        },
        token,
    )
    assert status == 200, project
    assert project["name"] == "中文论文展示名"
    status, bound = _request(
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
    assert status == 200, bound
    status, check = _request(
        running_server,
        "POST",
        "/api/check",
        {
            "project_id": project["project_id"],
        },
        token,
    )
    assert status == 200, check
    assert check["summary"]["compliant"] == 2
    assert check["world"]["journal_name"] == "Test Journal"
    _, state = _request(running_server, "GET", "/api/state")
    assert state["worlds"][0]["journal_name"] == "Test Journal"
    assert "name" not in state["worlds"][0]
    assert state["projects"][0]["latest_check"]["check_id"] == check["check_id"]


def test_project_upload_requires_the_declared_fields_without_creating_a_project(running_server):
    _, session = _request(running_server, "GET", "/api/session")
    status, result = _request(
        running_server,
        "POST",
        "/api/projects",
        {
            "name": "old.docx",
            "content_base64": base64.b64encode(template_bytes()).decode(),
        },
        session["token"],
    )
    assert status == 400
    assert "error" in result
    assert not (running_server.service.root / "inputs").exists()


@pytest.mark.parametrize(
    "headers",
    [
        {"Host": "hostile.example"},
        {"Origin": "https://hostile.example"},
        {"Sec-Fetch-Site": "cross-site"},
    ],
)
def test_foreign_origins_cannot_read_session_or_workspace(running_server, headers):
    connection = HTTPConnection(*running_server.server_address, timeout=5)
    connection.request("GET", "/api/session", headers=headers)
    response = connection.getresponse()
    assert response.status == 403
    assert "token" not in json.loads(response.read())
    connection.close()


def test_refused_post_closes_unconsumed_body(running_server):
    connection = HTTPConnection(*running_server.server_address, timeout=5)
    connection.request(
        "POST",
        "/api/projects",
        body=b"{}",
        headers={
            "Content-Type": "application/json",
            "X-RFW-Token": "wrong",
        },
    )
    response = connection.getresponse()
    assert response.status == 403
    response.read()
    assert connection.sock is None or connection.sock.recv(1) == b""
    connection.close()


@pytest.mark.parametrize(
    "framing",
    [
        "Content-Length: 1\r\nContent-Length: 2",
        "Transfer-Encoding: chunked\r\nContent-Length: 2",
        "Content-Length: 9999999999",
    ],
)
def test_invalid_request_framing_fails_before_payload_read(running_server, framing):
    host, port = running_server.server_address
    with socket.create_connection((host, port), timeout=5) as connection:
        request = (
            f"POST /api/projects HTTP/1.1\r\nHost: {host}:{port}\r\n"
            f"Content-Type: application/json\r\nX-RFW-Token: {running_server.session_token}\r\n"
            f"{framing}\r\n\r\n"
        )
        connection.sendall(request.encode())
        assert b"400" in connection.recv(4096)


def test_network_binding_is_not_silently_exposed(tmp_path):
    service = WorkbenchService.create(tmp_path / "library")
    with pytest.raises(ValueError, match="回环"):
        WorkbenchHttpServer(("0.0.0.0", 0), service)


@pytest.mark.parametrize("token", ["invalid-\u00e9", "\u00ff"])
def test_non_ascii_session_token_is_refused_without_crashing_or_writing(running_server, token):
    status, denied = _request(running_server, "POST", "/api/worlds", _world_payload(), token)
    assert status == 403
    assert "error" in denied
    assert "token" not in denied
    assert running_server.service.store.list_worlds() == []

    status, session = _request(running_server, "GET", "/api/session")
    assert status == 200
    status, world = _request(
        running_server, "POST", "/api/worlds", _world_payload(), session["token"]
    )
    assert status == 200
    assert world["version_id"].startswith("world-")


@pytest.mark.skipif(
    sys.platform == "darwin",
    reason="macOS assigns only 127.0.0.1 on the loopback interface without a manual alias",
)
def test_alternate_loopback_binding_accepts_only_its_actual_host(tmp_path):
    service = WorkbenchService.create(tmp_path / "library")
    server = WorkbenchHttpServer(("127.0.0.2", 0), service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert server.server_address[0] == "127.0.0.2"
        for hostname, expected_status in (
            ("localhost", 403),
            ("127.0.0.1", 403),
            ("127.0.0.2", 200),
        ):
            host = f"{hostname}:{server.server_port}"
            connection = HTTPConnection(*server.server_address, timeout=5)
            try:
                connection.request(
                    "GET", "/api/session", headers={"Host": host, "Origin": f"http://{host}"}
                )
                response = connection.getresponse()
                content = json.loads(response.read())
                assert response.status == expected_status, hostname
                if expected_status == 200:
                    assert content["token"] == server.session_token
                else:
                    assert "error" in content
                    assert "token" not in content
            finally:
                connection.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_unsupported_docx_compression_returns_json_and_preserves_upload_flow(running_server):
    captured = template_bytes()
    damaged = bytearray(captured)
    with ZipFile(BytesIO(captured)) as archive:
        first_entry = archive.infolist()[0]
        local_offset = first_entry.header_offset
        central_offset = archive.start_dir
    # Mark the fixture's first real entry with the same unsupported compression in both headers.
    struct.pack_into("<H", damaged, local_offset + 8, 99)
    struct.pack_into("<H", damaged, central_offset + 10, 99)
    _, session = _request(running_server, "GET", "/api/session")
    payload = {
        "name": "Controlled manuscript",
        "filename": "source.docx",
        "content_base64": base64.b64encode(damaged).decode("ascii"),
    }

    status, refused = _request(running_server, "POST", "/api/projects", payload, session["token"])
    assert status == 400
    assert "error" in refused
    status, state = _request(running_server, "GET", "/api/state")
    assert status == 200
    assert state["projects"] == []

    payload["content_base64"] = base64.b64encode(captured).decode("ascii")
    status, project = _request(running_server, "POST", "/api/projects", payload, session["token"])
    assert status == 200, project
    _, state = _request(running_server, "GET", "/api/state")
    assert [item["project_id"] for item in state["projects"]] == [project["project_id"]]


def _create_check_flow(server: WorkbenchHttpServer):
    _, session = _request(server, "GET", "/api/session")
    token = session["token"]
    status, world = _request(server, "POST", "/api/worlds", _world_payload(), token)
    assert status == 200
    status, project = _request(
        server,
        "POST",
        "/api/projects",
        {
            "name": "HTTP test manuscript",
            "filename": "source.docx",
            "content_base64": base64.b64encode(template_bytes()).decode("ascii"),
        },
        token,
    )
    assert status == 200
    status, binding = _request(
        server,
        "POST",
        "/api/bind",
        {
            "project_id": project["project_id"],
            "world_version_id": world["version_id"],
            "expected_binding_id": None,
        },
        token,
    )
    assert status == 200
    status, check = _request(
        server, "POST", "/api/check", {"project_id": project["project_id"]}, token
    )
    assert status == 200
    return token, world, project, check


def test_http_disposition_records_note_and_rejects_malformed_action(running_server):
    token, world, project, check = _create_check_flow(running_server)
    rule = world["rules"][0]
    status, disposition = _request(
        running_server,
        "POST",
        "/api/disposition",
        {
            "check_id": check["check_id"],
            "rule_id": rule["rule_id"],
            "action": "note",
            "note": "Reviewed through the HTTP workbench.",
        },
        token,
    )
    assert status == 200
    assert disposition["check_id"] == check["check_id"]
    assert disposition["verdict"] == next(
        item["verdict"] for item in check["rule_results"] if item["rule_id"] == rule["rule_id"]
    )
    status, malformed = _request(
        running_server,
        "POST",
        "/api/disposition",
        {
            "check_id": check["check_id"],
            "rule_id": rule["rule_id"],
            "action": "",
            "note": "",
        },
        token,
    )
    assert status == 400
    assert set(malformed) == {"error"}
    status, inspected = _request(running_server, "GET", f"/api/check?check_id={check['check_id']}")
    assert status == 200
    assert [item["disposition_id"] for item in inspected["dispositions"]] == [
        disposition["disposition_id"]
    ]
    assert inspected["project_id"] == project["project_id"]


def test_http_revise_creates_world_version_and_rejects_non_integer_expected(running_server):
    token, world, _, _ = _create_check_flow(running_server)
    rule = next(item for item in world["rules"] if item["property"] == "page_width_twips")
    status, revised = _request(
        running_server,
        "POST",
        "/api/revise",
        {
            "version_id": world["version_id"],
            "rule_id": rule["rule_id"],
            "expected": 12240,
            "reason": "Confirmed by the revised guide.",
        },
        token,
    )
    assert status == 200
    assert revised["version_id"] != world["version_id"]
    assert (
        next(item for item in revised["rules"] if item["rule_id"] == rule["rule_id"])["expected"]
        == 12240
    )
    status, malformed = _request(
        running_server,
        "POST",
        "/api/revise",
        {
            "version_id": world["version_id"],
            "rule_id": rule["rule_id"],
            "expected": "12240",
            "reason": "Invalid value type.",
        },
        token,
    )
    assert status == 400
    assert set(malformed) == {"error"}


def test_component_import_retains_sources_decisions_and_binding(running_server):
    token, world, project, check = _create_check_flow(running_server)
    width = next(rule for rule in world["rules"] if rule["property"] == "page_width_twips")
    original_binding = running_server.service.store.get_binding(project["project_id"])
    _, revised = _request(
        running_server,
        "POST",
        "/api/revise",
        {
            "version_id": world["version_id"],
            "rule_id": width["rule_id"],
            "expected": 12240,
            "reason": "Operator-selected letter width.",
        },
        token,
    )
    payload = {
        "version_id": revised["version_id"],
        "name": "agent-requirements.json",
        "content_base64": base64.b64encode(json.dumps(component()).encode()).decode(),
    }
    status, imported = _request(running_server, "POST", "/api/world-component", payload, token)
    assert status == 200
    assert len(imported["sources"]) == len(world["sources"]) + 1
    assert all(source in imported["sources"] for source in world["sources"])
    rules = {rule["property"]: rule for rule in imported["rules"]}
    assert rules["columns"]["basis_status"] == "candidate"
    assert rules["columns"]["expected"] == 2
    assert rules["page_width_twips"]["expected"] == 12240
    assert rules["page_width_twips"]["resolution"]["reason"] == "Operator-selected letter width."
    assert running_server.service.store.get_binding(project["project_id"]) == original_binding
    assert running_server.service.check_record(check["check_id"])["validity"] == "CURRENT"
    assert running_server.service.store.get_world(revised["version_id"]) == revised
    assert running_server.service.review(imported["version_id"])["fragments"]

    before = running_server.service.store.list_worlds()
    payload.update(
        preview=True,
        sources=[
            {
                "name": "publisher-page.txt",
                "kind": "guide_text",
                "content_base64": base64.b64encode(
                    b"Source URL: https://example.org/authors\nTwo-column layout for review."
                ).decode(),
            }
        ],
        decisions=[
            {"property": "columns", "expected": 1, "reason": "Use single column at initial review."}
        ],
    )
    status, preview = _request(running_server, "POST", "/api/world-component", payload, token)
    assert status == 200
    assert running_server.service.store.list_worlds() == before
    assert (
        next(rule for rule in preview["rules"] if rule["property"] == "columns")[
            "confirmation_method"
        ]
        == "human_decision"
    )
    payload["preview"] = False
    status, adopted = _request(running_server, "POST", "/api/world-component", payload, token)
    assert status == 200
    assert adopted["version_id"] == preview["version_id"]
    assert len(adopted["sources"]) == len(world["sources"]) + 2
    assert running_server.service.store.get_binding(project["project_id"]) == original_binding
    assert running_server.service.store.read_source(adopted["sources"][0]["source_id"])
    before = running_server.service.store.list_worlds()
    payload["decisions"] = [{"property": "columns", "expected": 0, "reason": "Invalid count."}]
    status, refused = _request(running_server, "POST", "/api/world-component", payload, token)
    assert status == 400
    assert running_server.service.store.list_worlds() == before
    payload["content_base64"] = base64.b64encode(b'{"rules": []}').decode()
    status, refused = _request(running_server, "POST", "/api/world-component", payload, token)
    assert status == 400
    assert set(refused) == {"error"}
    assert running_server.service.store.list_worlds() == before


def _render_bundle_for_project(project_root: Path, baseline_id: str, source_sha256: str):
    root = Path(__file__).resolve().parents[2]
    fixture_root = root / "reports/phase0/fixtures/s1-figures-tables"
    pdf = (fixture_root / "s1-figures-tables.pdf").read_bytes()
    profile = "wps-writer-12.1.0.28505"
    pages = {
        number: (fixture_root / "pages-150dpi" / f"page-{number}.png").read_bytes()
        for number in range(1, 4)
    }
    render_record = {
        "report_version": "1.1.0",
        "source_sha256": source_sha256,
        "render_copy_sha256": source_sha256,
        "source_unchanged": True,
        "output_path": "captured/source.pdf",
        "output_sha256": "3174c4aa7cc36bea04658ed332044f8555fdab1a92f87e2ae380398133648a04",
        "output_size": len(pdf),
        "render_profile_id": profile,
        "renderer_identity_status": "process_verified",
        "renderer_path": "C:/fixture/wps.exe",
        "renderer_sha256": "a" * 64,
        "renderer_file_version": "12.1.0.28505",
        "renderer_process_id": 123,
        "renderer_start_time_utc": "2026-09-24T00:00:00Z",
        "source_path": "captured/source.docx",
        "render_copy_path": "captured/render-copy.docx",
        "export_method": "Synthetic HTTP fixture record",
    }
    index = {
        "version": "s1-page-evidence-index-1.0.0",
        "status": "unverified",
        "pdf_sha256": render_record["output_sha256"],
        "render_profile_id": profile,
        "page_count": 3,
        "pages": [
            {
                "page_number": number,
                "path": f"captured/page-{number}.png",
                "sha256": sha256_file(fixture_root / "pages-150dpi" / f"page-{number}.png"),
                "parse_status": "unverified",
            }
            for number in range(1, 4)
        ],
    }
    annotation = json.loads(
        (root / "annotations/s1/s1-figures-tables/document-annotation.json").read_text(
            encoding="utf-8"
        )
    )
    evidence = json.loads(
        (root / "annotations/s1/s1-figures-tables/page-evidence.json").read_text(encoding="utf-8")
    )
    return register_render_bytes(
        project_root,
        baseline_id=baseline_id,
        render_record=json.dumps(render_record).encode("utf-8"),
        page_index=json.dumps(index).encode("utf-8"),
        pdf_bytes=pdf,
        page_images=pages,
        actor_id="http-test",
        confirmation_reason="Register captured page evidence for the HTTP test.",
        document_annotation=json.dumps(annotation).encode("utf-8"),
        page_evidence=json.dumps(evidence).encode("utf-8"),
    )


def test_http_libreoffice_render_registers_pdf_after_explicit_baseline(
    running_server, tmp_path, monkeypatch
):
    token = running_server.session_token
    status, project = _request(
        running_server,
        "POST",
        "/api/projects",
        {
            "name": "LibreOffice manuscript",
            "filename": "source.docx",
            "content_base64": base64.b64encode(template_bytes()).decode("ascii"),
        },
        token,
    )
    assert status == 200
    pdf = (
        Path(__file__).resolve().parents[2]
        / "reports/phase0/fixtures/s1-figures-tables/s1-figures-tables.pdf"
    ).read_bytes()
    executable = tmp_path / "soffice"
    executable.write_bytes(b"fake LibreOffice")
    executable.chmod(0o755)

    def runner(command: list[str], timeout: int) -> subprocess.CompletedProcess[bytes]:
        if command[1:] == ["--version"]:
            return subprocess.CompletedProcess(command, 0, b"LibreOffice 25.2\n", b"")
        output_root = Path(command[command.index("--outdir") + 1])
        (output_root / "baseline.pdf").write_bytes(pdf)
        return subprocess.CompletedProcess(command, 0, b"converted", b"")

    monkeypatch.setattr(
        "research_file_workbench.projects.render_service._run_command",
        runner,
    )
    payload = {
        "project_id": project["project_id"],
        "baseline_id": project["baseline_id"],
        "reason": "Render the saved baseline",
        "libreoffice_executable": executable.as_posix(),
    }
    status, rendered = _request(
        running_server,
        "POST",
        "/api/render-baseline",
        payload,
        token,
    )

    assert status == 200, rendered
    assert rendered["manifest"]["evidence_kind"] == "derived_pdf"
    assert rendered["manifest"]["mapping"] is None
    assert (
        Path(rendered["manifest"]["render_record"]["libreoffice_profile"]).parent
        == running_server.service.root / "var" / "libreoffice-profile"
    )
    status, listed = _request(
        running_server,
        "GET",
        f"/api/derived-renders?project_id={project['project_id']}"
        f"&baseline_id={project['baseline_id']}",
    )
    assert status == 200
    assert listed == {
        "project_id": project["project_id"],
        "baseline_id": project["baseline_id"],
        "derived_renders": [rendered],
    }
    status, content_type, body = _binary_request(
        running_server,
        f"/api/render?project_id={project['project_id']}"
        f"&baseline_id={project['baseline_id']}"
        f"&bundle_id={rendered['bundle_id']}&role=pdf&page_number=none",
    )
    assert status == 200
    assert content_type == "application/pdf"
    assert body == pdf
    status, manuscript = _request(
        running_server,
        "GET",
        f"/api/manuscript?project_id={project['project_id']}&baseline_id=current",
    )
    assert status == 200
    assert manuscript["render_bundles"] == []
    assert any(item["kind"] == "derived_render" for item in manuscript["evidence"])


def test_http_render_baseline_reports_missing_libreoffice_without_fallback(
    running_server, tmp_path
):
    token = running_server.session_token
    _, project = _request(
        running_server,
        "POST",
        "/api/projects",
        {
            "name": "Missing renderer manuscript",
            "filename": "source.docx",
            "content_base64": base64.b64encode(template_bytes()).decode("ascii"),
        },
        token,
    )
    status, rejected = _request(
        running_server,
        "POST",
        "/api/render-baseline",
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "reason": "Reject a caller-selected profile",
            "libreoffice_executable": (tmp_path / "missing-soffice").as_posix(),
            "libreoffice_profile": (tmp_path / "outside-profile").as_posix(),
        },
        token,
    )
    assert status == 400
    assert set(rejected) == {"error"}
    assert not (tmp_path / "outside-profile").exists()
    status, result = _request(
        running_server,
        "POST",
        "/api/render-baseline",
        {
            "project_id": project["project_id"],
            "baseline_id": project["baseline_id"],
            "reason": "Exercise unavailable renderer",
            "libreoffice_executable": (tmp_path / "missing-soffice").as_posix(),
        },
        token,
    )

    assert status == 503
    assert result["code"] == "renderer_unavailable"
    assert "error" in result


def test_http_render_page_image_serves_retained_bytes_and_rejects_invalid_selection(
    running_server, monkeypatch
):
    monkeypatch.setattr(
        "research_file_workbench.projects.render_service.read_pdf_page_count", lambda path: 3
    )
    _, session = _request(running_server, "GET", "/api/session")
    status, project = _request(
        running_server,
        "POST",
        "/api/projects",
        {
            "name": "Rendered HTTP manuscript",
            "filename": "source.docx",
            "content_base64": base64.b64encode(
                (
                    Path(__file__).resolve().parents[2]
                    / "tests/fixtures/docx/normal/s1-figures-tables/s1-figures-tables.docx"
                ).read_bytes()
            ).decode("ascii"),
        },
        session["token"],
    )
    assert status == 200
    project_root = running_server.service.project_root(project["project_id"])
    baseline = open_project(project_root).get_baseline()
    source_sha256 = baseline["source_sha256"]
    bundle = _render_bundle_for_project(project_root, baseline["baseline_id"], source_sha256)
    status, content_type, body = _binary_request(
        running_server,
        "/api/render?project_id={}&baseline_id={}&bundle_id={}&role=page_image&page_number=1".format(
            project["project_id"], project["baseline_id"], bundle["bundle_id"]
        ),
    )
    assert status == 200
    assert content_type == "image/png"
    assert body.startswith(b"\x89PNG\r\n\x1a\n")
    status, result = _request(
        running_server,
        "GET",
        "/api/render?project_id={}&baseline_id={}&bundle_id={}&role=page_image&page_number=none".format(
            project["project_id"], project["baseline_id"], bundle["bundle_id"]
        ),
    )
    assert status == 400
    assert set(result) == {"error"}
