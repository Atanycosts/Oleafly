"""The source review API uses retained bytes and never replaces world or check authority."""

import sqlite3
from pathlib import Path

import pytest

from research_file_workbench.journals.evidence import EVIDENCE_METHOD_VERSION
from research_file_workbench.journals.models import SourceInput
from research_file_workbench.workbench.service import WorkbenchService
from tests.journals.test_analysis import template_bytes
from tests.workbench.test_server import _request, _world_payload
from tests.workbench.test_server import running_server as running_server


def test_review_api_returns_exact_source_fragments_and_rule_links(running_server):
    _, session = _request(running_server, "GET", "/api/session")
    status, world = _request(
        running_server, "POST", "/api/worlds", _world_payload(), session["token"]
    )
    assert status == 200
    status, review = _request(
        running_server, "GET", f"/api/review?version_id={world['version_id']}"
    )
    assert status == 200
    assert review["world_version_id"] == world["version_id"]
    assert review["method_version"] == EVIDENCE_METHOD_VERSION
    paragraph = next(item for item in review["fragments"] if item["kind"] == "paragraph")
    sentence = next(item for item in review["fragments"] if item["kind"] == "sentence")
    assert paragraph["text"] == "All manuscript pages must use A4 paper."
    assert sentence["text"] == paragraph["text"]
    assert sentence["parent_fragment_id"] == paragraph["fragment_id"]
    assert len(review["rule_links"]) == len(world["rules"]) == 2
    assert all(item["fragment_ids"] == [paragraph["fragment_id"]] for item in review["rule_links"])
    _, unchanged = _request(running_server, "GET", f"/api/world?version_id={world['version_id']}")
    assert unchanged == world


@pytest.mark.parametrize(
    "query",
    [
        "",
        "version_id=",
        "version_id=missing&path=C:/private/source.docx",
        "version_id=missing&version_id=other",
    ],
)
def test_review_api_rejects_ambiguous_or_path_based_queries(running_server, query):
    status, result = _request(running_server, "GET", f"/api/review?{query}")
    assert status == 400
    assert set(result) == {"error"}


def test_review_api_reports_damaged_retained_bytes_without_partial_fragments(running_server):
    service = running_server.service
    source = SourceInput("guide.txt", "guide_text", b"All manuscript pages must use A4 paper.")
    world = service.import_world("journal-test", "Test", [source])
    with sqlite3.connect(service.store.database_path) as connection:
        connection.execute("UPDATE source SET content=?", (b"damaged",))
    status, result = _request(
        running_server, "GET", f"/api/review?version_id={world['version_id']}"
    )
    assert status == 500
    assert set(result) == {"error"}
    assert str(service.root) not in result["error"]


def test_review_and_restart_recovery_leave_binding_and_check_records_unchanged(tmp_path: Path):
    root = tmp_path / "library"
    service = WorkbenchService.create(root)
    source = SourceInput("guide.txt", "guide_text", b"All manuscript pages must use A4 paper.")
    world = service.import_world("journal-test", "Test", [source])
    project = service.import_manuscript("Manuscript", "manuscript.docx", template_bytes())
    binding = service.bind(project["project_id"], world["version_id"], None)
    checked = service.run_check(project["project_id"])
    retained_check = service.store.get_check(checked["check_id"])
    before = service.review(world["version_id"])
    reopened = WorkbenchService(root)
    assert reopened.review(world["version_id"]) == before
    assert reopened.store.get_world(world["version_id"]) == world
    assert reopened.store.get_binding(project["project_id"]) == binding
    assert reopened.store.get_check(checked["check_id"]) == retained_check
