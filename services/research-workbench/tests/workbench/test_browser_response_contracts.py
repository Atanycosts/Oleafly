"""Validate browser boundaries against live responses and deliberately damaged copies."""

import json
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlencode

import pymupdf

from tests.journals.test_analysis import template_bytes
from tests.journals.test_components import component
from tests.workbench.test_server import _request, _world_payload
from tests.workbench.test_workspace import bundle_upload, import_project, selection, upload


def _guide_pdf_bytes() -> bytes:
    """A minimal valid guidance PDF exercising the extracted fragment path."""
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((50, 100), "Margins must be 25 mm.", fontsize=10.0)
    payload = document.tobytes()
    document.close()
    return payload


def test_browser_validates_live_response_shapes_and_rejects_inconsistent_records(
    running_server, rendered_project, tmp_path
):
    node = shutil.which("node")
    assert node is not None, "Browser contract verification requires Node.js."
    responses = {}

    def capture(name, method, path, payload=None):
        status, response = _request(
            running_server, method, path, payload, running_server.session_token
        )
        assert status == 200, response
        responses[name] = {"path": path.split("?")[0], "response": response}
        return response

    capture("session", "GET", "/api/session")
    world = capture("world", "POST", "/api/worlds", _world_payload())
    capture("review", "GET", f"/api/review?version_id={world['version_id']}")
    fixture = (
        Path(__file__).parents[1] / "fixtures/docx/normal/s1-figures-tables/s1-figures-tables.docx"
    )
    source = fixture.read_bytes()
    rich_payload = _world_payload()
    second_component = {**component(), "component_id": "alternative-geometry"}
    rich_payload["sources"].extend(
        [
            {"name": "模板.docx", "kind": "template_docx", **upload(source)},
            {
                "name": "补充指南.txt",
                "kind": "guide_text",
                **upload("🔎 页面设置。Use A4 paper. 中文指南！".encode()),
            },
            {
                "name": "格式组件.json",
                "kind": "rule_component_json",
                **upload(json.dumps(component()).encode()),
            },
            {
                "name": "其他组件.json",
                "kind": "rule_component_json",
                **upload(json.dumps(second_component).encode()),
            },
            {"name": "指南.pdf", "kind": "guide_pdf", **upload(_guide_pdf_bytes())},
        ]
    )
    rich_world = capture("rich_world", "POST", "/api/worlds", rich_payload)
    capture("rich_review", "GET", f"/api/review?version_id={rich_world['version_id']}")
    pdf_source = next(item for item in rich_world["sources"] if item["kind"] == "guide_pdf")
    capture(
        "source_page",
        "GET",
        f"/api/source-page?version_id={rich_world['version_id']}&source_id={pdf_source['source_id']}&page=1",
    )
    project = capture(
        "project",
        "POST",
        "/api/projects",
        {"name": "待核对论文", "filename": "稿件.docx", **upload(source)},
    )
    capture(
        "binding",
        "POST",
        "/api/bind",
        {
            "project_id": project["project_id"],
            "world_version_id": world["version_id"],
            "expected_binding_id": None,
        },
    )
    capture("check", "POST", "/api/check", {"project_id": project["project_id"]})
    capture("table_read", "POST", "/api/read", selection(project, object_type="table"))
    first = capture("paged_read", "POST", "/api/read", selection(project))
    capture(
        "continued_read",
        "POST",
        "/api/read",
        selection(project, cursor=first["pagination"]["next_cursor"]),
    )
    capture(
        "saved_read",
        "GET",
        "/api/read?"
        + urlencode(
            {
                "project_id": project["project_id"],
                "read_record_id": first["delivery"]["read_record_id"],
            }
        ),
    )
    capture("state", "GET", "/api/state")
    capture("history", "GET", f"/api/history?project_id={project['project_id']}")
    capture(
        "manuscript",
        "GET",
        f"/api/manuscript?project_id={project['project_id']}&baseline_id=current",
    )
    capture(
        "baseline_update",
        "POST",
        "/api/baseline",
        {
            "project_id": project["project_id"],
            "expected_baseline_id": project["baseline_id"],
            "filename": "修订稿.docx",
            "reason": "确认作者修订",
            "request_id": "browser-contract-revision",
            **upload(source),
        },
    )
    capture(
        "historical_manuscript",
        "GET",
        f"/api/manuscript?project_id={project['project_id']}&baseline_id={project['baseline_id']}",
    )
    capture(
        "historical_check",
        "GET",
        f"/api/check?check_id={responses['check']['response']['check_id']}",
    )
    _, _, rendered_source, inputs, _ = rendered_project
    rendered = import_project(running_server, rendered_source.read_bytes())
    bundle = capture("render_bundle", "POST", "/api/render-bundle", bundle_upload(inputs, rendered))
    page_query = selection(rendered, object_type="image", page_number=1, page_size=10)
    page_query["render_bundle_id"] = bundle["bundle_id"]
    capture("page_read", "POST", "/api/read", page_query)
    capture(
        "rendered_manuscript",
        "GET",
        f"/api/manuscript?project_id={rendered['project_id']}&baseline_id=current",
    )
    pending = bundle_upload(inputs, rendered)
    pending.update(document_annotation=None, page_evidence=None)
    capture("pending_bundle", "POST", "/api/render-bundle", pending)
    empty_project = import_project(running_server, template_bytes())
    capture("empty_read", "POST", "/api/read", selection(empty_project, object_type="math"))
    test_script = Path(__file__).with_name("web-response-contracts.test.mjs")
    response_file = tmp_path / "browser-responses.json"
    response_file.write_text(json.dumps(responses), encoding="utf-8")
    result = subprocess.run(
        [node, "--test", str(test_script)],
        env={**os.environ, "RFW_BROWSER_RESPONSES": str(response_file)},
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
