"""Candidate adoption commits the working baseline and checked template binding together."""

from __future__ import annotations

import base64
import sqlite3
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.docx.format_snapshot import FORMAT_SNAPSHOT_METHOD_VERSION
from research_file_workbench.journals.store_records import BindingConflictError, WorldStoreError
from research_file_workbench.projects.models import BaselineConflictError, ProjectStoreError
from research_file_workbench.projects.service import open_project
from research_file_workbench.workbench.service import WorkbenchService
from research_file_workbench.workbench.template_candidate_adoption import (
    adopt_template_candidate,
)
from research_file_workbench.workbench.template_candidate_review import (
    CandidateReviewConflictError,
    get_template_candidate_review,
    save_template_candidate_review,
)
from research_file_workbench.workbench.template_service import adopt_template, check_template
from tests.journals.test_analysis import template_bytes


def _snapshot(content: bytes, *, size: int = 14):
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
                "role": "document_title",
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


def _world(service: WorkbenchService, content: bytes, journal_id: str):
    payload = {
        "journal_id": journal_id,
        "journal_name": journal_id,
        "article_type": "research_article",
        "stage": "initial_submission",
        "language": "en",
        "original": {
            "filename": "template.docx",
            "content_base64": base64.b64encode(content).decode(),
        },
        "normalized": {
            "filename": "template.docx",
            "content_base64": base64.b64encode(content).decode(),
            "provenance": None,
        },
        "snapshot": _snapshot(content),
    }
    return adopt_template(service, payload)


def _project(service: WorkbenchService, name: str, content: bytes):
    return service.import_manuscript(name, f"{name}.docx", content)


def _check_candidate(
    service: WorkbenchService,
    project: dict[str, object],
    content: bytes,
    world_id: str,
    request_id: str,
):
    project_id = str(project["project_id"])
    baseline_id = str(project["baseline_id"])
    reference = open_project(service.project_root(project_id)).save_format_snapshot(
        baseline_id, _snapshot(content, size=12)
    )
    binding = service.store.get_binding(project_id)
    return check_template(
        service,
        {
            "project_id": project_id,
            "expected_baseline_id": baseline_id,
            "world_version_id": world_id,
            "expected_binding_id": binding["binding_id"] if binding else None,
            "request_id": request_id,
            "origin": {"surface": "agent"},
            "snapshot_reference": {
                "baseline_id": reference["baseline_id"],
                "source_sha256": reference["source_sha256"],
                "snapshot_artifact_version_id": reference["snapshot_artifact_version_id"],
                "method_version": reference["method_version"],
            },
        },
    )


def _save_pending_review(
    service: WorkbenchService,
    target: dict[str, object],
    candidate: dict[str, object],
    candidate_content: bytes,
    check: dict[str, object],
):
    dependencies = check["dependencies"]
    target_baseline = open_project(service.project_root(str(target["project_id"]))).get_baseline(
        str(target["baseline_id"])
    )
    review = {
        "candidate_project_id": candidate["project_id"],
        "input_baseline_id": candidate["baseline_id"],
        "input_source_sha256": sha256_bytes(candidate_content),
        "candidate_baseline_id": check["baseline_id"],
        "candidate_source_sha256": check["source_sha256"],
        "candidate_binding_id": check["binding_id"],
        "candidate_check_id": check["check_id"],
        "world_version_id": check["world_version_id"],
        "snapshot_artifact_version_id": dependencies["snapshot_artifact_version_id"],
        "snapshot_method_version": check["reader_version"],
        "target_baseline_id": target["baseline_id"],
        "target_source_sha256": target_baseline["source_sha256"],
        "target_binding_id": target["binding"]["binding_id"],
        "original_source_sha256": None,
        "confirmed_items": [],
        "unconfirmed_items": [],
    }
    save_template_candidate_review(
        service,
        {
            "project_id": target["project_id"],
            "expected_candidate_check_id": None,
            "review": review,
        },
    )


def _setup(service: WorkbenchService, *, with_review: bool = False):
    world_a_content = template_bytes(((11906, 16838, 1440, 2),))
    world_b_content = template_bytes(((11906, 16838, 1440, 1),))
    target_content = template_bytes(((11906, 16838, 1440, 3),))
    candidate_content = template_bytes(((11906, 16838, 1440, 2), (11906, 16838, 1440, 1)))
    world_a = _world(service, world_a_content, "journal-a")
    world_b = _world(service, world_b_content, "journal-b")
    target = _project(service, "Target", target_content)
    target_id = str(target["project_id"])
    service.bind(target_id, str(world_a["version_id"]), None)
    target = service.project(target_id)
    candidate = _project(service, "Candidate", candidate_content)
    check = _check_candidate(
        service,
        candidate,
        candidate_content,
        str(world_b["version_id"]),
        "candidate-check-final",
    )
    candidate = service.project(str(candidate["project_id"]))
    body = {
        "project_id": target_id,
        "expected_baseline_id": target["baseline_id"],
        "expected_binding_id": target["binding"]["binding_id"],
        "candidate_project_id": candidate["project_id"],
        "candidate_baseline_id": candidate["baseline_id"],
        "expected_candidate_binding_id": candidate["binding"]["binding_id"],
        "candidate_source_sha256": sha256_bytes(candidate_content),
        "candidate_check_id": check["check_id"],
        "request_id": "adopt-candidate-final",
    }
    if with_review:
        _save_pending_review(service, target, candidate, candidate_content, check)
    return (
        world_a,
        world_b,
        target,
        candidate,
        candidate_content,
        body,
    )


def _adoption_rows(database_path: Path) -> int:
    with sqlite3.connect(database_path) as connection:
        return connection.execute("SELECT count(*) FROM template_candidate_adoption").fetchone()[0]


def _target_counts(database_path: Path) -> dict[str, int]:
    with sqlite3.connect(database_path) as connection:
        return {
            table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            for table in (
                "artifact",
                "baseline",
                "baseline_request",
                "evidence",
                "baseline_evidence",
            )
        }


def test_adoption_appends_exact_candidate_baseline_and_checked_world(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    world_a, world_b, target, candidate, candidate_content, body = _setup(service, with_review=True)
    target_root = service.project_root(str(target["project_id"]))
    target_before = open_project(target_root).list_baselines()
    target_bindings_before = service.store.list_bindings(str(target["project_id"]))
    candidate_root = service.project_root(str(candidate["project_id"]))
    candidate_baselines_before = open_project(candidate_root).list_baselines()
    candidate_bindings_before = service.store.list_bindings(str(candidate["project_id"]))

    result = adopt_template_candidate(service, body)

    target_store = open_project(target_root)
    adopted = target_store.get_baseline()
    assert result["result_baseline_id"] == adopted["baseline_id"]
    assert adopted["source_sha256"] == body["candidate_source_sha256"]
    assert (
        target_store.read_artifact(f"artifact-version-{body['candidate_source_sha256']}")
        == candidate_content
    )
    binding = service.store.get_binding(str(target["project_id"]))
    assert result["binding"] == binding
    assert binding["baseline_id"] == adopted["baseline_id"]
    assert binding["world_version_id"] == world_b["version_id"]
    assert binding["world_version_id"] != world_a["version_id"]
    assert target_store.list_baselines()[: len(target_before)] == target_before
    assert (
        service.store.list_bindings(str(target["project_id"]))[: len(target_bindings_before)]
        == target_bindings_before
    )
    assert open_project(candidate_root).list_baselines() == candidate_baselines_before
    assert service.store.list_bindings(str(candidate["project_id"])) == candidate_bindings_before


def test_adoption_requires_the_current_pending_review(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, _, _, body = _setup(service)
    target_store = open_project(service.project_root(str(target["project_id"])))
    before = target_store.list_baselines()

    with pytest.raises(CandidateReviewConflictError):
        adopt_template_candidate(service, body)

    assert target_store.list_baselines() == before
    assert _adoption_rows(target_store.database_path) == 0


def test_damaged_template_source_refuses_adoption_without_consuming_review(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    _, world_b, target, candidate, _, body = _setup(service, with_review=True)
    target_store = open_project(service.project_root(str(target["project_id"])))
    before = target_store.list_baselines()
    with sqlite3.connect(service.store.database_path) as connection:
        connection.execute(
            "UPDATE source SET content=? WHERE source_id=?",
            (b"damaged retained template", world_b["sources"][0]["source_id"]),
        )

    with pytest.raises(WorldStoreError, match="immutable identity"):
        adopt_template_candidate(service, body)

    assert target_store.list_baselines() == before
    assert _adoption_rows(target_store.database_path) == 0
    stored = open_project(
        service.project_root(str(target["project_id"]))
    ).get_template_candidate_review()
    assert stored["candidate_check_id"] == body["candidate_check_id"]
    with pytest.raises(ProjectStoreError):
        get_template_candidate_review(service, str(target["project_id"]))


def test_success_replay_ignores_moved_target_baseline_and_binding(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    world_a, _, target, _, _, body = _setup(service, with_review=True)
    result = adopt_template_candidate(service, body)
    target_id = str(target["project_id"])
    target_store = open_project(service.project_root(target_id))
    saved = service.update_manuscript(
        target_id,
        result["result_baseline_id"],
        "target.docx",
        template_bytes(((11906, 16838, 1440, 4),)),
        "A later manual save after adoption.",
        "target-save-after-adoption",
    )
    later_binding = service.bind(
        target_id,
        str(world_a["version_id"]),
        result["binding"]["binding_id"],
    )
    baseline_count = len(target_store.list_baselines())
    binding_count = len(service.store.list_bindings(target_id))
    adoption_count = _adoption_rows(target_store.database_path)

    replayed = adopt_template_candidate(service, body)

    assert replayed == result
    assert target_store.get_baseline()["baseline_id"] == saved["result_baseline_id"]
    assert service.store.get_binding(target_id) == later_binding
    assert len(target_store.list_baselines()) == baseline_count
    assert len(service.store.list_bindings(target_id)) == binding_count
    assert _adoption_rows(target_store.database_path) == adoption_count
    changed = deepcopy(body)
    changed["candidate_source_sha256"] = "0" * 64
    with pytest.raises(BindingConflictError, match="不同的稿件或候选"):
        adopt_template_candidate(service, changed)
    assert len(target_store.list_baselines()) == baseline_count
    assert len(service.store.list_bindings(target_id)) == binding_count


def test_target_baseline_and_binding_cas_fail_without_partial_writes(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, _, _, body = _setup(service, with_review=True)
    target_id = str(target["project_id"])
    target_store = open_project(service.project_root(target_id))
    baseline_count = len(target_store.list_baselines())
    binding_count = len(service.store.list_bindings(target_id))

    stale_baseline = deepcopy(body)
    stale_baseline["expected_baseline_id"] = "baseline-" + "0" * 32
    with pytest.raises(BaselineConflictError):
        adopt_template_candidate(service, stale_baseline)
    assert len(target_store.list_baselines()) == baseline_count
    assert len(service.store.list_bindings(target_id)) == binding_count
    assert _adoption_rows(target_store.database_path) == 0

    stale_binding = deepcopy(body)
    stale_binding["expected_binding_id"] = "binding-" + "0" * 32
    with pytest.raises(BindingConflictError):
        adopt_template_candidate(service, stale_binding)
    assert len(target_store.list_baselines()) == baseline_count
    assert len(service.store.list_bindings(target_id)) == binding_count
    assert _adoption_rows(target_store.database_path) == 0


@pytest.mark.parametrize("changed", ["baseline", "template"])
def test_adoption_does_not_retarget_the_review_to_current_inputs(tmp_path: Path, changed: str):
    service = WorkbenchService.create(tmp_path / "library")
    _, world_b, target, _, _, body = _setup(service, with_review=True)
    target_id = str(target["project_id"])
    target_store = open_project(service.project_root(target_id))
    if changed == "baseline":
        saved = service.update_manuscript(
            target_id,
            str(target["baseline_id"]),
            "target.docx",
            template_bytes(((11906, 16838, 1440, 4),)),
            "Manual save after reviewing the candidate.",
            "target-new-version",
        )
        body["expected_baseline_id"] = saved["result_baseline_id"]
        conflict = BaselineConflictError
    else:
        bound = service.bind(
            target_id, str(world_b["version_id"]), str(body["expected_binding_id"])
        )
        body["expected_binding_id"] = bound["binding_id"]
        conflict = BindingConflictError
    baselines = target_store.list_baselines()
    bindings = service.store.list_bindings(target_id)
    pending = target_store.get_template_candidate_review()
    with pytest.raises(conflict):
        adopt_template_candidate(service, body)
    assert target_store.list_baselines() == baselines
    assert service.store.list_bindings(target_id) == bindings
    assert target_store.get_template_candidate_review() == pending
    assert _adoption_rows(target_store.database_path) == 0


def test_changed_candidate_baseline_is_refused_without_target_writes(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, candidate, candidate_content, body = _setup(service, with_review=True)
    target_store = open_project(service.project_root(str(target["project_id"])))
    baseline_count = len(target_store.list_baselines())
    service.update_manuscript(
        str(candidate["project_id"]),
        str(candidate["baseline_id"]),
        "candidate.docx",
        candidate_content,
        "The candidate moved after the final check.",
        "candidate-later-save",
    )

    with pytest.raises(BaselineConflictError, match="候选项目"):
        adopt_template_candidate(service, body)

    assert len(target_store.list_baselines()) == baseline_count
    assert _adoption_rows(target_store.database_path) == 0


def test_changed_candidate_template_binding_is_refused_for_same_baseline(
    tmp_path: Path,
):
    service = WorkbenchService.create(tmp_path / "library")
    world_a, _, target, candidate, _, body = _setup(service, with_review=True)
    target_store = open_project(service.project_root(str(target["project_id"])))
    baseline_count = len(target_store.list_baselines())
    candidate_project_id = str(candidate["project_id"])
    service.bind(
        candidate_project_id,
        str(world_a["version_id"]),
        str(candidate["binding"]["binding_id"]),
    )
    current = service.project(candidate_project_id)
    assert current["baseline_id"] == candidate["baseline_id"]
    assert current["binding"]["binding_id"] != candidate["binding"]["binding_id"]

    with pytest.raises(BindingConflictError, match="绑定"):
        adopt_template_candidate(service, body)

    assert len(target_store.list_baselines()) == baseline_count
    assert _adoption_rows(target_store.database_path) == 0


def test_candidate_requires_a_current_binding_and_template_check(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    world = _world(service, template_bytes(((11906, 16838, 1440, 1),)), "journal-c")
    candidate_content = template_bytes(((11906, 16838, 1440, 2),))
    target = _project(service, "Target", template_bytes(((11906, 16838, 1440, 3),)))
    candidate = _project(service, "Candidate", candidate_content)
    open_project(service.project_root(str(candidate["project_id"]))).save_format_snapshot(
        str(candidate["baseline_id"]), _snapshot(candidate_content, size=12)
    )
    target_store = open_project(service.project_root(str(target["project_id"])))
    body = {
        "project_id": target["project_id"],
        "expected_baseline_id": target["baseline_id"],
        "expected_binding_id": None,
        "candidate_project_id": candidate["project_id"],
        "candidate_baseline_id": candidate["baseline_id"],
        "expected_candidate_binding_id": "binding-" + "0" * 32,
        "candidate_source_sha256": sha256_bytes(candidate_content),
        "candidate_check_id": "check-" + "0" * 32,
        "request_id": "adopt-unchecked-candidate",
    }

    with pytest.raises(BindingConflictError, match="绑定|检查"):
        adopt_template_candidate(service, body)

    assert target_store.get_baseline()["baseline_id"] == target["baseline_id"]
    assert _adoption_rows(target_store.database_path) == 0
    assert service.store.get_world(str(world["version_id"])) == world


def test_wrong_candidate_hash_saves_nothing(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    _, _, target, _, _, body = _setup(service, with_review=True)
    target_store = open_project(service.project_root(str(target["project_id"])))
    before = _target_counts(target_store.database_path)
    changed = deepcopy(body)
    changed["candidate_source_sha256"] = "0" * 64

    with pytest.raises(ValueError, match="哈希"):
        adopt_template_candidate(service, changed)

    assert _target_counts(target_store.database_path) == before
    assert _adoption_rows(target_store.database_path) == 0


def test_world_binding_failure_rolls_back_the_new_project_baseline(tmp_path: Path):
    service = WorkbenchService.create(tmp_path / "library")
    _, world_b, target, _, _, body = _setup(service, with_review=True)
    target_store = open_project(service.project_root(str(target["project_id"])))
    counts_before = _target_counts(target_store.database_path)
    target_before = target_store.list_baselines()
    binding_before = service.store.get_binding(str(target["project_id"]))
    with sqlite3.connect(service.store.database_path) as connection:
        connection.execute(
            "CREATE TRIGGER reject_adoption_binding BEFORE INSERT ON binding "
            "BEGIN SELECT RAISE(ABORT,'adoption binding refused'); END"
        )

    with pytest.raises((sqlite3.Error, ProjectStoreError), match="adoption binding refused"):
        adopt_template_candidate(service, body)

    assert _target_counts(target_store.database_path) == counts_before
    assert target_store.list_baselines() == target_before
    assert target_store.get_baseline()["baseline_id"] == target["baseline_id"]
    assert service.store.get_binding(str(target["project_id"])) == binding_before
    assert _adoption_rows(target_store.database_path) == 0

    with sqlite3.connect(service.store.database_path) as connection:
        connection.execute("DROP TRIGGER reject_adoption_binding")
    applied = adopt_template_candidate(service, body)
    assert applied["binding"]["world_version_id"] == world_b["version_id"]
