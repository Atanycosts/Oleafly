"""Verify enriched manuscript reads against a retained, byte-identical DOCX baseline."""

import base64
from pathlib import Path
from zipfile import ZipFile

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.docx.query import QUERY_VERSION
from research_file_workbench.workbench.service import WorkbenchService
from tests.workbench.test_server import _request

FIXTURE = (
    Path(__file__).resolve().parents[1]
    / "fixtures/docx/normal/s1-regions-fields/s1-regions-fields.docx"
)


def test_read_delivers_exact_retained_comment_and_accepted_text_without_saving_docx(running_server):
    captured = FIXTURE.read_bytes()
    _, session = _request(running_server, "GET", "/api/session")
    token = session["token"]
    status, project = _request(
        running_server,
        "POST",
        "/api/projects",
        {
            "name": "Tracked manuscript",
            "filename": "tracked.docx",
            "content_base64": base64.b64encode(captured).decode(),
        },
        token,
    )
    assert status == 200, project
    project_id, baseline_id = project["project_id"], project["baseline_id"]

    def read_objects(object_type):
        status, response = _request(
            running_server,
            "POST",
            "/api/read",
            {
                "project_id": project_id,
                "baseline_id": baseline_id,
                "render_bundle_id": None,
                "query": {
                    "region": "body",
                    "object_type": object_type,
                    "object_id": None,
                    "page_number": None,
                    "page_size": 20,
                    "cursor": None,
                },
            },
            token,
        )
        assert status == 200, response
        assert response["project"]["baseline_id"] == baseline_id
        assert response["source"]["sha256"] == sha256_bytes(captured)
        assert (
            response["query_version"] == response["read_receipt"]["method_version"] == QUERY_VERSION
        )
        return response

    text_read = read_objects("text_block")
    revised = next(
        item for item in text_read["items"] if item["content"]["revision_state"] == "mixed"
    )
    assert revised["content"]["text"] == "RFW-FX-RF-REVISION-001 RFW-FX-RF-REVISION-INSERTED-001"
    assert "RFW-FX-RF-REVISION-DELETED-001" in revised["content"]["source_text"]
    assert revised["content"]["text_projection"] == "accepted_revisions"
    source_range = next(
        value
        for value in text_read["read_receipt"]["ranges"]
        if value["locator"] == revised["range_locator"]
    )
    with ZipFile(FIXTURE) as archive:
        part = archive.read(revised["part_path"])
    assert b"RFW-FX-RF-REVISION-DELETED-001" in part[source_range["start"] : source_range["end"]]

    reference_read = read_objects("reference")
    (anchor,) = [
        item for item in reference_read["items"] if item["content"]["kind"] == "comment_anchor"
    ]
    assert anchor["content"]["reference_id"] == "0"
    assert anchor["content"]["target_part"] == "word/comments.xml"
    assert anchor["content"]["comment"] == {
        "text": "RFW-FX-RF-COMMENT-BODY-001",
        "text_projection": "accepted_revisions",
        "author": "RFW",
        "date": "2026-09-24T00:00:00Z",
        "node_locator": "word/comments.xml#comment[1]",
    }

    running_server.service = WorkbenchService(running_server.service.root)
    for response in (text_read, reference_read):
        record_id = response["delivery"]["read_record_id"]
        assert _request(
            running_server, "GET", f"/api/read?project_id={project_id}&read_record_id={record_id}"
        ) == (200, response)

    status, source = _request(
        running_server,
        "GET",
        f"/api/manuscript-source?project_id={project_id}&baseline_id={baseline_id}",
    )
    assert status == 200, source
    assert source["source_sha256"] == sha256_bytes(captured)
    assert base64.b64decode(source["content_base64"]) == captured == FIXTURE.read_bytes()
    store = running_server.service.manuscript(project_id, None)
    assert [value["baseline_id"] for value in store["baselines"]] == [baseline_id]

    observations = store["evidence"]
    original = next(
        item["value"]
        for item in observations
        if item["object_locator"]["object_id"] == revised["object_id"]
    )
    assert original["text"] == revised["content"]["source_text"]
    assert "text_projection" not in original
