"""Reviewed DOCX format candidates survive workspace reopen without model execution."""

from __future__ import annotations

import json
import threading
from copy import deepcopy
from http.client import HTTPConnection
from pathlib import Path

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.projects.models import BaselineConflictError
from research_file_workbench.projects.service import open_project
from research_file_workbench.projects.store import ProjectStore
from research_file_workbench.workbench.server import WorkbenchHttpServer
from research_file_workbench.workbench.service import WorkbenchService
from research_file_workbench.workbench.template_candidate_adoption import (
    adopt_template_candidate,
)
from research_file_workbench.workbench.template_candidate_review import (
    CandidateReviewConflictError,
    get_template_candidate_review,
    save_template_candidate_review,
)
from tests.journals.test_analysis import template_bytes
from tests.workbench.test_template_candidate_adoption import _check_candidate, _setup


def _item(identity: str):
    return {
        "id": identity,
        "para_id": "para-1",
        "location": "Opening paragraph",
        "property": "paragraph.alignment",
        "role": "body",
        "before": "left",
        "expected": "center",
        "template_location": "Body",
        "group": {
            "category": "body",
            "action": "alignment",
            "heading_level": 1,
        },
    }


def _table_item(identity: str):
    return {
        **_item(identity),
        "property": "table.layout",
        "row": 1,
        "group": {
            "category": "table",
            "action": "layout",
            "object_number": 2,
            "table_area": "header",
        },
    }


def _review(
    service: WorkbenchService,
    target: dict[str, object],
    candidate: dict[str, object],
    body: dict[str, object],
    *,
    original_source_sha256: str | None,
) -> dict[str, object]:
    candidate_store = open_project(service.project_root(str(candidate["project_id"])))
    initial = candidate_store.list_baselines()[0]
    target_baseline = open_project(service.project_root(str(target["project_id"]))).get_baseline()
    check = service.store.get_check(str(body["candidate_check_id"]))
    dependencies = check["dependencies"]
    confirmed = _item("confirmed-item")
    unconfirmed = _item("unconfirmed-item")
    return {
        "candidate_project_id": body["candidate_project_id"],
        "input_baseline_id": initial["baseline_id"],
        "input_source_sha256": initial["source_sha256"],
        "candidate_baseline_id": body["candidate_baseline_id"],
        "candidate_source_sha256": body["candidate_source_sha256"],
        "candidate_binding_id": body["expected_candidate_binding_id"],
        "candidate_check_id": body["candidate_check_id"],
        "world_version_id": check["world_version_id"],
        "snapshot_artifact_version_id": dependencies["snapshot_artifact_version_id"],
        "snapshot_method_version": check["reader_version"],
        "target_baseline_id": body["expected_baseline_id"],
        "target_source_sha256": target_baseline["source_sha256"],
        "target_binding_id": body["expected_binding_id"],
        "original_source_sha256": original_source_sha256,
        "confirmed_items": [confirmed],
        "unconfirmed_items": [unconfirmed],
    }


def _save(
    service: WorkbenchService,
    target_id: str,
    review: dict[str, object],
    expected_candidate_check_id: str | None,
):
    return save_template_candidate_review(
        service,
        {
            "project_id": target_id,
            "expected_candidate_check_id": expected_candidate_check_id,
            "review": review,
        },
    )


def _http_request(server: WorkbenchHttpServer, method: str, path: str, payload=None, token=None):
    connection = HTTPConnection(*server.server_address, timeout=10)
    body = None if payload is None else json.dumps(payload).encode()
    headers = {"Accept": "application/json"}
    if body is not None:
        headers.update({"Content-Type": "application/json", "Content-Length": str(len(body))})
    if token is not None:
        headers["X-RFW-Token"] = token
    connection.request(method, path, body=body, headers=headers)
    response = connection.getresponse()
    content = json.loads(response.read())
    connection.close()
    return response.status, content


def test_review_survives_reopen_and_keeps_the_checked_template_override(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    _, world_b, target, candidate, _, body = _setup(service)
    review = _review(
        service,
        target,
        candidate,
        body,
        original_source_sha256="1" * 64,
    )
    assert review["target_binding_id"] != body["expected_candidate_binding_id"]
    assert review["world_version_id"] == world_b["version_id"]

    _save(service, str(target["project_id"]), review, None)
    reopened = WorkbenchService(service.root)

    restored = get_template_candidate_review(reopened, str(target["project_id"]))

    assert restored == {
        "review": review,
        "status": "ready",
    }
    assert restored["review"]["world_version_id"] == world_b["version_id"]
    assert restored["review"]["original_source_sha256"] == "1" * 64


def test_review_preserves_optional_table_item_fields(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, candidate, _, body = _setup(service)
    review = _review(service, target, candidate, body, original_source_sha256=None)
    review["confirmed_items"] = [
        {**_table_item("table-item"), "template_object_id": "/word/document.xml#0.0.3.2"}
    ]

    _save(service, str(target["project_id"]), review, None)
    reopened = WorkbenchService(service.root)

    restored = get_template_candidate_review(reopened, str(target["project_id"]))

    assert restored == {"review": review, "status": "ready"}
    assert restored["review"]["confirmed_items"][0]["row"] == 1
    assert restored["review"]["confirmed_items"][0]["group"]["object_number"] == 2
    assert restored["review"]["confirmed_items"][0]["group"]["table_area"] == "header"


def test_review_rejects_invalid_optional_table_item_fields(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, candidate, _, body = _setup(service)
    review = _review(service, target, candidate, body, original_source_sha256=None)
    invalid_values = {
        "row": [0, -1, True, 1.5, "1"],
        "group.object_number": [0, -1, True, 1.5, "1"],
        "group.table_area": ["outside", "", None],
    }

    for field, values in invalid_values.items():
        for value in values:
            invalid = deepcopy(review)
            item = _table_item("invalid-table-item")
            if field == "row":
                item["row"] = value
            else:
                item["group"][field.split(".")[1]] = value
            invalid["confirmed_items"] = [item]
            with pytest.raises(ValueError):
                _save(service, str(target["project_id"]), invalid, None)

    assert get_template_candidate_review(service, str(target["project_id"])) == {"review": None}


def test_review_reports_conflicts_without_losing_candidate_download(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    _, world_b, target, candidate, candidate_content, body = _setup(service)
    target_id = str(target["project_id"])
    candidate_id = str(candidate["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)
    _save(service, target_id, review, None)

    service.update_manuscript(
        target_id,
        str(target["baseline_id"]),
        "target.docx",
        template_bytes(((11906, 16838, 1440, 5),)),
        "The working manuscript moved after the candidate review.",
        "target-after-candidate-review",
    )
    target_conflict = get_template_candidate_review(service, target_id)
    assert target_conflict["status"] == "conflict"
    assert target_conflict["reason"] == "target_baseline_changed"
    assert (
        service.manuscript_source(candidate_id, str(candidate["baseline_id"]))["content_base64"]
        is not None
    )
    assert open_project(service.project_root(candidate_id)).get_baseline()[
        "source_sha256"
    ] == sha256_bytes(candidate_content)


def test_target_binding_change_blocks_ready(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    _, world_b, target, candidate, _, body = _setup(service)
    target_id = str(target["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)
    _save(service, target_id, review, None)

    service.bind(
        target_id,
        str(world_b["version_id"]),
        str(target["binding"]["binding_id"]),
    )
    target_binding_conflict = get_template_candidate_review(service, target_id)
    assert target_binding_conflict["status"] == "conflict"
    assert target_binding_conflict["reason"] == "target_binding_changed"


def test_target_binding_change_is_saved_as_conflict(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    _, world_b, target, candidate, _, body = _setup(service)
    target_id = str(target["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)

    service.bind(
        target_id,
        str(world_b["version_id"]),
        str(target["binding"]["binding_id"]),
    )
    saved = _save(service, target_id, review, None)

    assert saved["status"] == "conflict"
    assert saved["reason"] == "target_binding_changed"
    assert get_template_candidate_review(service, target_id) == saved


def test_target_conflict_can_still_be_saved_and_restored_as_conflict(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, candidate, _, body = _setup(service)
    target_id = str(target["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)
    service.update_manuscript(
        target_id,
        str(target["baseline_id"]),
        "target.docx",
        template_bytes(((11906, 16838, 1440, 7),)),
        "The manuscript moved while the candidate review was being saved.",
        "target-before-candidate-review-save",
    )

    saved = _save(service, target_id, review, None)
    restored = get_template_candidate_review(service, target_id)

    assert saved["status"] == "conflict"
    assert saved["reason"] == "target_baseline_changed"
    assert restored == saved
    assert restored["review"] == review


def test_target_binding_may_retain_an_older_baseline(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, candidate, _, body = _setup(service)
    target_id = str(target["project_id"])
    updated = service.update_manuscript(
        target_id,
        str(target["baseline_id"]),
        "target.docx",
        template_bytes(((11906, 16838, 1440, 8),)),
        "Save the manuscript without rebinding its existing template.",
        "target-save-before-review",
    )
    review_body = {
        **body,
        "expected_baseline_id": updated["result_baseline_id"],
    }
    review = _review(
        service,
        {
            **target,
            "baseline_id": updated["result_baseline_id"],
        },
        candidate,
        review_body,
        original_source_sha256=None,
    )
    assert service.store.get_binding(target_id)["baseline_id"] != review["target_baseline_id"]

    saved = _save(service, target_id, review, None)

    assert saved["status"] == "ready"


def test_candidate_baseline_change_blocks_ready(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, candidate, _, body = _setup(service)
    target_id = str(target["project_id"])
    candidate_id = str(candidate["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)
    _save(service, target_id, review, None)

    service.update_manuscript(
        candidate_id,
        str(candidate["baseline_id"]),
        "candidate.docx",
        template_bytes(((11906, 16838, 1440, 6),)),
        "The final candidate moved after review.",
        "candidate-after-review",
    )
    candidate_conflict = get_template_candidate_review(service, target_id)
    assert candidate_conflict["status"] == "conflict"
    assert candidate_conflict["reason"] == "candidate_baseline_changed"


def test_candidate_baseline_change_after_review_cannot_be_saved(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, candidate, _, body = _setup(service)
    target_id = str(target["project_id"])
    candidate_id = str(candidate["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)
    service.update_manuscript(
        candidate_id,
        str(candidate["baseline_id"]),
        "candidate.docx",
        template_bytes(((11906, 16838, 1440, 9),)),
        "The candidate moved before the review was saved.",
        "candidate-before-review-save",
    )

    with pytest.raises(BaselineConflictError):
        _save(service, target_id, review, None)

    assert get_template_candidate_review(service, target_id) == {"review": None}


def test_candidate_binding_change_blocks_ready(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    head_world, _, target, candidate, _, body = _setup(service)
    target_id = str(target["project_id"])
    candidate_id = str(candidate["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)
    _save(service, target_id, review, None)

    service.bind(
        candidate_id,
        str(head_world["version_id"]),
        str(candidate["binding"]["binding_id"]),
    )

    restored = get_template_candidate_review(service, target_id)
    assert restored["status"] == "conflict"
    assert restored["reason"] == "candidate_binding_changed"


def test_save_uses_the_candidate_check_as_compare_and_swap(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, candidate, _, body = _setup(service)
    target_id = str(target["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)

    _save(service, target_id, review, None)
    with pytest.raises(ValueError, match="pending format candidate changed"):
        _save(service, target_id, review, "check-" + "0" * 32)
    assert _save(service, target_id, review, str(body["candidate_check_id"]))["status"] == "ready"


def test_successful_adoption_clears_only_the_matching_pending_review(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, candidate, _, body = _setup(service)
    target_id = str(target["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)
    _save(service, target_id, review, None)

    adopt_template_candidate(service, body)

    assert get_template_candidate_review(service, target_id) == {"review": None}


def test_adoption_with_another_valid_check_does_not_clear_the_pending_review(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    _, world_b, target, candidate, candidate_content, body = _setup(service)
    target_id = str(target["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)
    _save(service, target_id, review, None)
    other_check = _check_candidate(
        service,
        candidate,
        candidate_content,
        str(world_b["version_id"]),
        "candidate-check-other",
    )
    other_body = {**body, "candidate_check_id": other_check["check_id"]}

    with pytest.raises(CandidateReviewConflictError):
        adopt_template_candidate(service, other_body)

    restored = get_template_candidate_review(service, target_id)
    assert restored["review"] == review
    assert restored["status"] == "ready"


def test_http_routes_save_restore_and_clear_the_review(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, candidate, _, body = _setup(service)
    target_id = str(target["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)
    server = WorkbenchHttpServer(("127.0.0.1", 0), service)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, session = _http_request(server, "GET", "/api/session")
        assert status == 200
        status, empty = _http_request(
            server,
            "GET",
            f"/api/template-candidate-review?project_id={target_id}",
        )
        assert (status, empty) == (200, {"review": None})
        status, saved = _http_request(
            server,
            "POST",
            "/api/template-candidate-review",
            {
                "project_id": target_id,
                "expected_candidate_check_id": None,
                "review": review,
            },
            session["token"],
        )
        assert status == 200
        assert saved["status"] == "ready"
        status, restored = _http_request(
            server,
            "GET",
            f"/api/template-candidate-review?project_id={target_id}",
        )
        assert status == 200
        assert restored["review"] == review
        status, conflict = _http_request(
            server,
            "POST",
            "/api/template-candidate-review",
            {
                "project_id": target_id,
                "expected_candidate_check_id": "check-" + "0" * 32,
                "review": review,
            },
            session["token"],
        )
        assert status == 409
        assert conflict["code"] == "candidate_review_conflict"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_summary_pages_the_saved_review_after_reopen(running_server, monkeypatch):
    service = running_server.service
    world_a, world_b, target, candidate, candidate_content, body = _setup(service)
    target_id = str(target["project_id"])
    candidate_id = str(candidate["project_id"])
    check_id = str(body["candidate_check_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)
    review["confirmed_items"] = [
        {**_table_item("table-item"), "template_object_id": "/word/document.xml#0.0.0"},
        _item("older-label-only"),
    ]
    target_store = open_project(service.project_root(target_id))
    target_artifact = "artifact-version-" + str(review["target_source_sha256"])
    original = target_store.read_artifact(target_artifact)
    path = f"/api/template-candidate-summary?project_id={target_id}"
    assert _http_request(running_server, "GET", path) == (
        200,
        {"schema_version": 1, "summary": None},
    )
    _, session = _http_request(running_server, "GET", "/api/session")
    status, saved = _http_request(
        running_server,
        "POST",
        "/api/template-candidate-review",
        {"project_id": target_id, "expected_candidate_check_id": None, "review": review},
        session["token"],
    )
    assert (status, saved) == (200, {"review": review, "status": "ready"})
    assert target_store.get_template_candidate_review()["checklist"]["schema_version"] == 1

    running_server.service = WorkbenchService(service.root)

    def unexpected_read(*args, **kwargs):
        pytest.fail("Reading the saved checklist must not decode snapshots or load raw findings")

    with monkeypatch.context() as patch:
        patch.setattr(ProjectStore, "get_format_snapshot", unexpected_read)
        patch.setattr(WorkbenchService, "retained_template_findings", unexpected_read)
        status, response = _http_request(running_server, "GET", path)
        assert status == 200, response
        assert set(response) == {"schema_version", "summary"}
        summary = response["summary"]
        assert summary["target_project_id"] == target_id
        assert summary["candidate_project_id"] == candidate_id
        assert summary["candidate_check_id"] == check_id
        assert summary["candidate_source_sha256"] == sha256_bytes(candidate_content)
        assert summary["template"]["version_id"] == world_b["version_id"] != world_a["version_id"]
        assert summary["template"]["source_sha256"] == world_b["template"]["source_sha256"]
        assert summary["template"]["name"] == "template.docx"
        assert summary["counts"] == {
            "confirmed": 2,
            "unconfirmed": 1,
            "remaining": 1,
            "observed_difference": 1,
            "cannot_determine": 0,
        }

        def read_page(collection, offset=0):
            status, result = _http_request(
                running_server,
                "GET",
                f"{path}&check_id={check_id}&collection={collection}&offset={offset}&limit=1",
            )
            assert status == 200, result
            assert result["summary"] == summary
            return result["page"]

        first = read_page("confirmed")
        assert first == {
            "collection": "confirmed",
            "items": [review["confirmed_items"][0]],
            "total": 2,
            "next_offset": 1,
        }
        second = read_page("confirmed", first["next_offset"])
        assert second["items"] == [review["confirmed_items"][1]]
        assert second["next_offset"] is None
        assert "template_object_id" not in second["items"][0]
        assert read_page("unconfirmed")["items"] == review["unconfirmed_items"]

        remaining = read_page("remaining")
        group = remaining["items"][0]
        example = group["examples"]["observed_difference"]
        assert (example["property_path"], example["observed"], example["expected"]) == (
            "run.fontSizePt",
            12,
            14,
        )
        assert example["template_object_ids"] == ["/word/document.xml#0.0.0"]
        assert example["location"]["id"].startswith("location-")
        assert remaining["next_offset"] is None

    assert target_store.info()["current_baseline_id"] == target["baseline_id"]
    assert target_store.read_artifact(target_artifact) == original
    assert service.store.get_binding(target_id) == target["binding"]
    assert (
        open_project(service.project_root(candidate_id)).read_artifact(
            "artifact-version-" + sha256_bytes(candidate_content)
        )
        == candidate_content
    )

    for query in (
        "offset=0",
        "collection=unknown",
        "collection=remaining&offset=1",
        "collection=remaining&limit=1001",
        "collection=remaining&limit=1&limit=2",
    ):
        assert _http_request(running_server, "GET", f"{path}&{query}")[0] == 400
    status, mismatch = _http_request(running_server, "GET", f"{path}&check_id=check-unrelated")
    assert status == 400 and mismatch["code"] == "candidate_review_check_mismatch"

    status, adopted = _http_request(
        running_server,
        "POST",
        "/api/template-candidate-adopt",
        body,
        session["token"],
    )
    assert status == 200, adopted
    adopted_baseline = target_store.get_baseline(str(adopted["result_baseline_id"]))
    assert (
        target_store.read_artifact("artifact-version-" + str(adopted_baseline["source_sha256"]))
        == candidate_content
    )
    assert _http_request(running_server, "GET", path) == (
        200,
        {"schema_version": 1, "summary": None},
    )
    assert _http_request(running_server, "GET", f"{path}&check_id={check_id}")[0] == 400


def test_old_review_stays_unchanged_and_readable_after_http_baseline_conflict(running_server):
    service = running_server.service
    _, _, target, candidate, _, body = _setup(service)
    target_id = str(target["project_id"])
    review = _review(service, target, candidate, body, original_source_sha256=None)
    target_store = open_project(service.project_root(target_id))
    target_store.save_template_candidate_review(review, None)
    path = f"/api/template-candidate-summary?project_id={target_id}"
    status, before = _http_request(running_server, "GET", path)
    assert status == 200, before
    assert before["summary"]["counts"]["confirmed"] == 1

    edited = template_bytes(((11906, 16838, 1440, 5),))
    updated = service.update_manuscript(
        target_id,
        str(target["baseline_id"]),
        "target.docx",
        edited,
        "Manual save while formatting candidate is pending.",
        "summary-http-conflict",
    )
    _, session = _http_request(running_server, "GET", "/api/session")
    status, conflict = _http_request(
        running_server,
        "POST",
        "/api/template-candidate-adopt",
        {**body, "expected_baseline_id": updated["result_baseline_id"]},
        session["token"],
    )
    assert status == 409 and conflict["code"] == "baseline_conflict"
    status, after = _http_request(running_server, "GET", path)
    assert status == 200, after
    assert after["summary"] == {
        **before["summary"],
        "status": "conflict",
        "reason": "target_baseline_changed",
    }
    assert target_store.get_template_candidate_review() == review
    assert target_store.read_artifact("artifact-version-" + sha256_bytes(edited)) == edited
    assert target_store.info()["current_baseline_id"] == updated["result_baseline_id"]
