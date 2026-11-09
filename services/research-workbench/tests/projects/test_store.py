from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from copy import deepcopy
from pathlib import Path
from threading import Barrier
from typing import cast

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.docx import read_docx
from research_file_workbench.docx.query import ReadQuery, query_docx
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.projects.models import (
    BaselineConflictError,
    BaselineRequest,
    ProjectStoreError,
)
from research_file_workbench.projects.store import ProjectStore

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx"
REGIONS_SOURCE = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"
FIGURES_SOURCE = FIXTURE_ROOT / "normal/s1-figures-tables/s1-figures-tables.docx"
PROJECT_ID = "project-store-tests"
ACTOR_ID = "operator-store-tests"


@pytest.fixture
def database_path(tmp_path: Path) -> Path:
    return tmp_path / "application" / "project.sqlite3"


@pytest.fixture
def store(database_path: Path, tmp_path: Path) -> ProjectStore:
    author_workspace = tmp_path / "author-workspace"
    author_workspace.mkdir()
    database_path.parent.mkdir()
    return ProjectStore.create(
        database_path,
        project_id=PROJECT_ID,
        author_workspace_root=author_workspace.resolve().as_posix(),
    )


def _request(
    source: Path = REGIONS_SOURCE,
    *,
    request_id: str = "request-first-import",
    expected_baseline_id: str | None = None,
) -> BaselineRequest:
    return BaselineRequest(
        project_id=PROJECT_ID,
        actor_id=ACTOR_ID,
        request_id=request_id,
        expected_baseline_id=expected_baseline_id,
        source_sha256=sha256_bytes(source.read_bytes()),
    )


def _evidence(request: BaselineRequest, *, suffix: str) -> JsonObject:
    return {
        "evidence_id": f"evidence-{suffix}",
        "evidence_version": f"evidence-version-{suffix}",
        "kind": "source_observation",
        "artifact_version_id": request.artifact_version_id,
        "object_locator": {"node_locator": "word/document.xml#paragraph[1]"},
        "parse_status": "parsed",
        "limitations": ["Structure observation does not establish semantic correctness."],
        "dependencies": [request.artifact_version_id, READER_VERSION],
        "statement": "The source has a first body paragraph.",
        "scope": {"region": "body"},
        "extraction_method": "docx-structure-reader",
        "extraction_method_version": READER_VERSION,
        "verification_record_ids": [],
    }


def _apply(
    store: ProjectStore,
    request: BaselineRequest,
    source: Path = REGIONS_SOURCE,
) -> JsonObject:
    return store.apply_baseline(
        request,
        source_bytes=source.read_bytes(),
        source_path=source.resolve().as_posix(),
        confirmation_reason="Confirmed this fixture as the project's reading source.",
        evidence=[_evidence(request, suffix=request.request_id)],
        reader_version=READER_VERSION,
    )


def _baseline_id(result: JsonObject) -> str:
    baseline_id = result["result_baseline_id"]
    assert isinstance(baseline_id, str)
    return baseline_id


def _read_payload(baseline_id: str) -> tuple[JsonObject, JsonObject]:
    response = query_docx(
        read_docx(REGIONS_SOURCE),
        ReadQuery(region="header"),
        task_id="task-header-read",
        actor_id=ACTOR_ID,
        client_id="client-store-tests",
        baseline_id=baseline_id,
    )
    response["project"] = {"project_id": PROJECT_ID, "baseline_id": baseline_id}
    receipt = cast(JsonObject, response["read_receipt"])
    task: JsonObject = {
        "task_id": "task-header-read",
        "baseline_id": baseline_id,
        "scope": response["query_scope"],
        "status": "partial",
        "actual_read_ranges": receipt["ranges"],
        "unresolved_items": response["limitations"],
    }
    return task, response


def _database_rows(database_path: Path) -> dict[str, list[tuple[object, ...]]]:
    with sqlite3.connect(database_path) as connection:
        tables = connection.execute(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        return {
            name: sorted(
                connection.execute('SELECT * FROM "' + name.replace('"', '""') + '"').fetchall(),
                key=repr,
            )
            for (name,) in tables
        }


def _install_pointer_failure(database_path: Path) -> None:
    with sqlite3.connect(database_path) as connection:
        tables = connection.execute(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        pointer_tables = []
        for (name,) in tables:
            quoted = '"' + name.replace('"', '""') + '"'
            columns = connection.execute(f"PRAGMA table_info({quoted})").fetchall()
            if any(column[1] == "current_baseline_id" for column in columns):
                pointer_tables.append(quoted)
        assert len(pointer_tables) == 1
        connection.execute(
            "CREATE TRIGGER fail_baseline_pointer BEFORE UPDATE OF current_baseline_id ON "
            + pointer_tables[0]
            + " BEGIN SELECT RAISE(ABORT, 'test pointer failure'); END"
        )


def test_same_request_replays_original_result_after_current_baseline_advances(
    store: ProjectStore, database_path: Path
) -> None:
    first_request = _request()
    first_result = _apply(store, first_request)
    second_request = _request(
        FIGURES_SOURCE,
        request_id="request-second-import",
        expected_baseline_id=_baseline_id(first_result),
    )
    second_result = _apply(store, second_request, FIGURES_SOURCE)
    reopened = ProjectStore(database_path)

    replay = reopened.apply_baseline(
        first_request,
        source_bytes=None,
        source_path=REGIONS_SOURCE.resolve().as_posix(),
        confirmation_reason="Repeated transport request after successful publication.",
        evidence=[],
        reader_version=READER_VERSION,
    )

    assert first_result["status"] == second_result["status"] == "APPLIED"
    assert replay == first_result
    assert (
        reopened.lookup_request(ACTOR_ID, first_request.request_id, first_request.request_digest)
        == first_result
    )
    assert reopened.get_baseline()["baseline_id"] == _baseline_id(second_result)
    assert len(reopened.list_baselines()) == 2
    assert reopened.read_artifact(first_request.artifact_version_id) == REGIONS_SOURCE.read_bytes()


def test_same_request_identifier_with_changed_content_does_not_move_current_baseline(
    store: ProjectStore, database_path: Path
) -> None:
    first_request = _request()
    first_result = _apply(store, first_request)
    changed_request = _request(FIGURES_SOURCE, request_id=first_request.request_id)

    conflict = _apply(store, changed_request, FIGURES_SOURCE)

    assert conflict["status"] == "IDEMPOTENCY_CONFLICT"
    assert conflict["result_baseline_id"] is None
    assert store.get_baseline()["baseline_id"] == _baseline_id(first_result)
    assert len(store.list_baselines()) == 1
    assert (
        store.lookup_request(ACTOR_ID, first_request.request_id, first_request.request_digest)
        == first_result
    )
    retained = ProjectStore(database_path).get_request(ACTOR_ID, first_request.request_id)
    assert retained["result"] == first_result
    assert retained["conflict_attempts"] == [conflict]


def test_two_connections_with_same_expected_baseline_keep_one_durable_conflict(
    store: ProjectStore, database_path: Path
) -> None:
    initial_result = _apply(store, _request())
    expected = _baseline_id(initial_result)
    requests = [
        _request(FIGURES_SOURCE, request_id="request-concurrent-a", expected_baseline_id=expected),
        _request(REGIONS_SOURCE, request_id="request-concurrent-b", expected_baseline_id=expected),
    ]
    barrier = Barrier(2)

    def submit(request: BaselineRequest, source: Path) -> JsonObject:
        connection = ProjectStore(database_path)
        barrier.wait(timeout=10)
        return _apply(connection, request, source)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(submit, request, source)
            for request, source in zip(requests, [FIGURES_SOURCE, REGIONS_SOURCE], strict=True)
        ]
        results = [future.result(timeout=30) for future in futures]

    assert sorted(result["status"] for result in results) == ["APPLIED", "BASELINE_CONFLICT"]
    applied = next(result for result in results if result["status"] == "APPLIED")
    conflict = next(result for result in results if result["status"] == "BASELINE_CONFLICT")
    assert conflict["result_baseline_id"] is None
    reopened = ProjectStore(database_path)
    assert reopened.get_baseline()["baseline_id"] == _baseline_id(applied)
    assert len(reopened.list_baselines()) == 2
    for request, result in zip(requests, results, strict=True):
        assert (
            reopened.lookup_request(ACTOR_ID, request.request_id, request.request_digest) == result
        )


def test_unknown_request_lookup_is_not_a_successful_empty_result(store: ProjectStore) -> None:
    request = _request()

    assert store.lookup_request(ACTOR_ID, request.request_id, request.request_digest) is None


def test_persisted_rejection_replays_after_new_baseline_without_becoming_applied(
    store: ProjectStore, database_path: Path
) -> None:
    rejected_request = _request(request_id="request-rejected-source")
    rejection = store.record_rejection(
        rejected_request,
        source_path=REGIONS_SOURCE.resolve().as_posix(),
        confirmation_reason="Confirmed the source version identified by this request.",
        reason="The source changed before its confirmed version could be captured.",
    )

    assert rejection["status"] == "REJECTED"
    assert rejection["result_baseline_id"] is None
    assert store.info()["current_baseline_id"] is None
    assert store.list_baselines() == []
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT count(*) FROM artifact").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM evidence").fetchone()[0] == 0

    valid_request = _request(request_id="request-following-inspection")
    applied = _apply(store, valid_request)
    reopened = ProjectStore(database_path)
    replay = _apply(reopened, rejected_request)

    assert replay == rejection
    assert reopened.get_request(ACTOR_ID, rejected_request.request_id)["result"] == rejection
    assert reopened.get_baseline()["baseline_id"] == _baseline_id(applied)
    assert len(reopened.list_baselines()) == 1


def test_failed_pointer_commit_rolls_back_snapshot_evidence_and_request_together(
    store: ProjectStore, database_path: Path
) -> None:
    first_result = _apply(store, _request())
    first_baseline_id = _baseline_id(first_result)
    second_request = _request(
        FIGURES_SOURCE,
        request_id="request-aborted-commit",
        expected_baseline_id=first_baseline_id,
    )
    before = _database_rows(database_path)
    _install_pointer_failure(database_path)

    with pytest.raises((sqlite3.Error, ProjectStoreError)):
        _apply(store, second_request, FIGURES_SOURCE)

    assert _database_rows(database_path) == before
    reopened = ProjectStore(database_path)
    assert reopened.get_baseline()["baseline_id"] == first_baseline_id
    assert (
        reopened.lookup_request(ACTOR_ID, second_request.request_id, second_request.request_digest)
        is None
    )
    with sqlite3.connect(database_path) as connection:
        connection.execute("DROP TRIGGER fail_baseline_pointer")

    committed = _apply(reopened, second_request, FIGURES_SOURCE)

    assert committed["status"] == "APPLIED"
    assert len(reopened.list_baselines()) == 2
    assert reopened.read_artifact(second_request.artifact_version_id) == FIGURES_SOURCE.read_bytes()


def test_corrupted_snapshot_blob_is_rejected_on_read(
    store: ProjectStore, database_path: Path
) -> None:
    request = _request()
    _apply(store, request)
    source_bytes = REGIONS_SOURCE.read_bytes()
    with sqlite3.connect(database_path) as connection:
        tables = connection.execute(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        changed = 0
        for (name,) in tables:
            table = '"' + name.replace('"', '""') + '"'
            columns = connection.execute(f"PRAGMA table_info({table})").fetchall()
            for column in columns:
                if column[2].upper() == "BLOB":
                    blob_column = '"' + column[1].replace('"', '""') + '"'
                    changed += connection.execute(
                        f"UPDATE {table} SET {blob_column} = ? WHERE {blob_column} = ?",
                        (b"corrupted persisted manuscript bytes", source_bytes),
                    ).rowcount
        assert changed == 1

    with pytest.raises(ProjectStoreError):
        ProjectStore(database_path).read_artifact(request.artifact_version_id)


@pytest.mark.parametrize(
    "source_bytes", [None, REGIONS_SOURCE.read_bytes()], ids=["stored-bytes", "captured-bytes"]
)
def test_corrupted_artifact_digest_cannot_publish_another_baseline(
    store: ProjectStore, database_path: Path, source_bytes: bytes | None
) -> None:
    initial = _request()
    baseline_id = _baseline_id(_apply(store, initial))
    with closing(sqlite3.connect(database_path)) as connection, connection:
        connection.execute(
            "UPDATE artifact SET sha256=? WHERE version_id=?",
            ("0" * 64, initial.artifact_version_id),
        )
    before = _database_rows(database_path)
    request = _request(request_id="request-corrupt-artifact", expected_baseline_id=baseline_id)

    with pytest.raises(ProjectStoreError, match="immutable version"):
        store.apply_baseline(
            request,
            source_bytes=source_bytes,
            source_path=REGIONS_SOURCE.resolve().as_posix(),
            confirmation_reason="Confirm the fixture version for this regression.",
            evidence=[_evidence(request, suffix=request.request_id)],
            reader_version=READER_VERSION,
        )

    assert _database_rows(database_path) == before
    assert store.info()["current_baseline_id"] == baseline_id
    assert store.lookup_request(ACTOR_ID, request.request_id, request.request_digest) is None


def test_database_reopen_preserves_immutable_history_and_original_source_bytes(
    store: ProjectStore, database_path: Path
) -> None:
    first_request = _request()
    first_result = _apply(store, first_request)
    first_baseline = store.get_baseline(_baseline_id(first_result))
    second_request = _request(
        FIGURES_SOURCE,
        request_id="request-new-manuscript",
        expected_baseline_id=_baseline_id(first_result),
    )
    second_result = _apply(store, second_request, FIGURES_SOURCE)

    reopened = ProjectStore(database_path)

    assert reopened.get_baseline(_baseline_id(first_result)) == first_baseline
    assert reopened.get_baseline()["baseline_id"] == _baseline_id(second_result)
    assert reopened.read_artifact(first_request.artifact_version_id) == REGIONS_SOURCE.read_bytes()
    assert reopened.read_artifact(second_request.artifact_version_id) == FIGURES_SOURCE.read_bytes()
    assert {item["baseline_id"] for item in reopened.list_baselines()} == {
        _baseline_id(first_result),
        _baseline_id(second_result),
    }


def test_source_change_marks_retained_evidence_stale_without_inventing_review(
    store: ProjectStore, database_path: Path
) -> None:
    request = _request()
    first_result = _apply(store, request)
    first_baseline_id = _baseline_id(first_result)
    evidence_version = cast(str, _evidence(request, suffix=request.request_id)["evidence_version"])
    original = store.list_evidence(first_baseline_id, reader_version=READER_VERSION)
    second_request = _request(
        FIGURES_SOURCE,
        request_id="request-new-evidence-source",
        expected_baseline_id=first_baseline_id,
    )
    second_result = _apply(store, second_request, FIGURES_SOURCE)
    reopened = ProjectStore(database_path)
    historical = reopened.list_evidence(first_baseline_id, reader_version=READER_VERSION)
    current = reopened.list_evidence(reader_version=READER_VERSION)

    assert len(original) == len(historical) == len(current) == 1
    assert original[0]["applicability_to_current_baseline"] == "CURRENT"
    assert original[0]["verification_status"] == "NOT_REVIEWED"
    assert historical[0]["applicability_to_current_baseline"] == "STALE"
    assert historical[0]["stale_reasons"] == ["source_version_changed"]
    assert historical[0]["verification_status"] == "NOT_REVIEWED"
    assert historical[0]["baseline_is_current"] is False
    assert historical[0]["evidence_version"] == evidence_version
    assert historical[0]["statement"] == original[0]["statement"]
    assert historical[0]["verification_record_ids"] == []
    assert current[0]["applicability_to_current_baseline"] == "CURRENT"
    assert current[0]["verification_status"] == "NOT_REVIEWED"
    assert evidence_version in cast(list[str], second_result["invalidated_refs"])


def test_reader_change_marks_same_source_evidence_stale_without_overwriting_history(
    store: ProjectStore,
) -> None:
    first_result = _apply(store, _request())
    baseline_id = _baseline_id(first_result)
    initial = store.list_evidence(baseline_id, reader_version=READER_VERSION)

    changed_reader = store.list_evidence(baseline_id, reader_version="reader-corrected-method")

    assert changed_reader[0]["applicability_to_current_baseline"] == "STALE"
    assert changed_reader[0]["stale_reasons"] == ["reader_version_changed"]
    assert changed_reader[0]["verification_status"] == "NOT_REVIEWED"
    assert changed_reader[0]["evidence_version"] == initial[0]["evidence_version"]
    assert store.list_evidence(baseline_id, reader_version=READER_VERSION) == initial


def test_same_source_rebaseline_reuses_artifact_and_unchanged_evidence(
    store: ProjectStore, database_path: Path
) -> None:
    first_request = _request()
    first_result = _apply(store, first_request)
    first_baseline_id = _baseline_id(first_result)
    second_request = _request(
        request_id="request-rebind-same-source", expected_baseline_id=first_baseline_id
    )
    repeated_evidence = _evidence(first_request, suffix=first_request.request_id)

    second_result = store.apply_baseline(
        second_request,
        source_bytes=None,
        source_path=REGIONS_SOURCE.resolve().as_posix(),
        confirmation_reason="Confirmed a new reading baseline that keeps the source version.",
        evidence=[repeated_evidence],
        reader_version=READER_VERSION,
    )

    assert second_result["status"] == "APPLIED"
    assert _baseline_id(second_result) != first_baseline_id
    assert second_result["invalidated_refs"] == []
    assert store.get_baseline()["artifact_version_ids"] == [first_request.artifact_version_id]
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT count(*) FROM artifact").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM evidence").fetchone()[0] == 1
        assert connection.execute("SELECT count(*) FROM baseline_evidence").fetchone()[0] == 2
    historical = store.list_evidence(first_baseline_id, reader_version=READER_VERSION)
    assert historical[0]["baseline_is_current"] is False
    assert historical[0]["applicability_to_current_baseline"] == "CURRENT"
    assert historical[0]["verification_status"] == "NOT_REVIEWED"


def test_same_evidence_version_cannot_be_overwritten_with_a_new_statement(
    store: ProjectStore, database_path: Path
) -> None:
    first_request = _request()
    first_result = _apply(store, first_request)
    second_request = _request(
        request_id="request-conflicting-evidence",
        expected_baseline_id=_baseline_id(first_result),
    )
    conflicting_evidence = _evidence(first_request, suffix=first_request.request_id)
    conflicting_evidence["statement"] = "A different statement cannot reuse immutable evidence."
    before = _database_rows(database_path)

    with pytest.raises(ProjectStoreError):
        store.apply_baseline(
            second_request,
            source_bytes=None,
            source_path=REGIONS_SOURCE.resolve().as_posix(),
            confirmation_reason="An independent conflicting evidence submission.",
            evidence=[conflicting_evidence],
            reader_version=READER_VERSION,
        )

    assert _database_rows(database_path) == before


def test_method_update_keeps_source_bytes_but_invalidates_old_method_evidence(
    store: ProjectStore, database_path: Path
) -> None:
    first_request = _request()
    first_result = _apply(store, first_request)
    first_baseline_id = _baseline_id(first_result)
    second_request = _request(
        request_id="request-updated-reader", expected_baseline_id=first_baseline_id
    )
    reader_version = "reader-corrected-method"
    corrected_evidence = _evidence(second_request, suffix=second_request.request_id)
    corrected_evidence["extraction_method_version"] = reader_version
    corrected_evidence["dependencies"] = [second_request.artifact_version_id, reader_version]

    second_result = store.apply_baseline(
        second_request,
        source_bytes=None,
        source_path=REGIONS_SOURCE.resolve().as_posix(),
        confirmation_reason="Confirmed re-extraction using the corrected method.",
        evidence=[corrected_evidence],
        reader_version=reader_version,
    )
    old_evidence = store.list_evidence(first_baseline_id, reader_version=reader_version)
    current_evidence = store.list_evidence(reader_version=reader_version)

    assert old_evidence[0]["applicability_to_current_baseline"] == "STALE"
    assert old_evidence[0]["stale_reasons"] == ["reader_version_changed"]
    assert old_evidence[0]["verification_status"] == "NOT_REVIEWED"
    assert current_evidence[0]["applicability_to_current_baseline"] == "CURRENT"
    assert current_evidence[0]["verification_status"] == "NOT_REVIEWED"
    assert old_evidence[0]["evidence_version"] in cast(list[str], second_result["invalidated_refs"])
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT count(*) FROM artifact").fetchone()[0] == 1


def test_reopen_recovers_exact_read_response_and_historical_receipt(
    store: ProjectStore, database_path: Path
) -> None:
    first_result = _apply(store, _request())
    first_baseline_id = _baseline_id(first_result)
    task, response = _read_payload(first_baseline_id)
    record_id = cast(str, cast(JsonObject, response["read_receipt"])["read_record_id"])
    store.save_read(
        baseline_id=first_baseline_id,
        require_current=True,
        task=task,
        response=response,
    )
    second_request = _request(
        FIGURES_SOURCE,
        request_id="request-after-read",
        expected_baseline_id=first_baseline_id,
    )
    second_result = _apply(store, second_request, FIGURES_SOURCE)

    reopened = ProjectStore(database_path)

    assert reopened.get_read(record_id) == response
    assert reopened.list_reads(first_baseline_id)
    assert reopened.list_reads(_baseline_id(second_result)) == []


def test_read_started_on_old_current_baseline_is_rejected_without_saved_response(
    store: ProjectStore,
) -> None:
    first_result = _apply(store, _request())
    first_baseline_id = _baseline_id(first_result)
    task, response = _read_payload(first_baseline_id)
    _apply(
        store,
        _request(
            FIGURES_SOURCE,
            request_id="request-concurrent-read-update",
            expected_baseline_id=first_baseline_id,
        ),
        FIGURES_SOURCE,
    )

    with pytest.raises(BaselineConflictError):
        store.save_read(
            baseline_id=first_baseline_id,
            require_current=True,
            task=task,
            response=response,
        )

    assert store.list_reads(first_baseline_id) == []
    store.save_read(
        baseline_id=first_baseline_id,
        require_current=False,
        task=task,
        response=response,
    )
    assert store.list_reads(first_baseline_id)


@pytest.mark.parametrize(
    "mismatch", ["task", "task_baseline", "response_baseline", "version", "unread_version"]
)
def test_read_receipt_binding_mismatch_cannot_be_persisted(
    store: ProjectStore, mismatch: str
) -> None:
    first_result = _apply(store, _request())
    baseline_id = _baseline_id(first_result)
    task, response = _read_payload(baseline_id)
    if mismatch == "task":
        task["task_id"] = "task-another-read"
    elif mismatch == "task_baseline":
        task["baseline_id"] = "baseline-another-source"
    elif mismatch == "response_baseline":
        cast(JsonObject, response["project"])["baseline_id"] = "baseline-another-source"
    elif mismatch == "version":
        receipt = cast(JsonObject, response["read_receipt"])
        receipt["returned_versions"] = ["artifact-version-" + "0" * 64]
        for item in cast(list[JsonObject], receipt["ranges"]):
            item["version_id"] = "artifact-version-" + "0" * 64
    else:
        receipt = cast(JsonObject, response["read_receipt"])
        cast(list[JsonObject], receipt["unread_ranges"])[0]["version_id"] = (
            "artifact-version-" + "0" * 64
        )

    with pytest.raises(ProjectStoreError):
        store.save_read(
            baseline_id=baseline_id,
            require_current=True,
            task=task,
            response=response,
        )

    assert store.list_reads(baseline_id) == []


@pytest.mark.parametrize(
    "mismatch",
    [
        "missing_items",
        "duplicate_items",
        "unknown_object",
        "wrong_content",
        "non_object_content",
        "wrong_item_range",
        "wrong_range_status",
        "missing_unread",
        "response_pagination",
        "wrong_total",
        "wrong_offset",
        "wrong_truncation",
        "wrong_method",
        "wrong_status",
        "wrong_selection_delivery",
        "wrong_reader_issues",
        "wrong_unsupported_records",
        "wrong_coverage_gaps",
        "wrong_limitations",
    ],
)
def test_inconsistent_delivered_content_is_rejected_without_any_saved_records(
    store: ProjectStore, database_path: Path, mismatch: str
) -> None:
    baseline_id = _baseline_id(_apply(store, _request()))
    task, response = _read_payload(baseline_id)
    items = cast(list[JsonObject], response["items"])
    receipt = cast(JsonObject, response["read_receipt"])
    if mismatch == "missing_items":
        response["items"] = []
    elif mismatch == "duplicate_items":
        items.append(deepcopy(items[0]))
    elif mismatch == "unknown_object":
        items[0]["object_id"] = "object-does-not-exist"
    elif mismatch == "wrong_content":
        cast(JsonObject, items[0]["content"])["text"] = "Unobserved replacement text"
    elif mismatch == "non_object_content":
        items[0]["content"] = "not an object"
    elif mismatch == "wrong_item_range":
        items[0]["range_locator"] = "word/document.xml#paragraph[1]"
    elif mismatch == "wrong_range_status":
        returned_range = cast(list[JsonObject], receipt["ranges"])[0]
        returned_range["parse_status"] = "partial"
        returned_range["limitations"] = ["Invented limitation"]
    elif mismatch == "missing_unread":
        receipt["unread_ranges"] = []
    elif mismatch == "response_pagination":
        cast(JsonObject, response["pagination"])["page_size"] = 100
    elif mismatch in {"wrong_total", "wrong_offset"}:
        field = "total_ranges" if mismatch == "wrong_total" else "page_number"
        cast(JsonObject, receipt["pagination"])[field] = 2
        cast(JsonObject, response["pagination"])[field] = 2
    elif mismatch == "wrong_truncation":
        receipt["truncation"] = True
    elif mismatch == "wrong_method":
        response["reader_version"] = "reader-incompatible"
    elif mismatch == "wrong_status":
        response["status"] = "completed"
    elif mismatch == "wrong_selection_delivery":
        # Claim the opposite delivery state, so a plausible but wrong axis value is refused.
        response["selection_delivery"] = (
            "continuation_available"
            if response["selection_delivery"] == "continuation_exhausted"
            else "continuation_exhausted"
        )
    elif mismatch == "wrong_reader_issues":
        cast(list[str], response["reader_issues"]).append("Invented reader issue")
    elif mismatch == "wrong_unsupported_records":
        cast(list[JsonObject], response["unsupported_records"]).append(
            {
                "source_location": "word/document.xml#unknown",
                "kind": "invented",
                "relationship_id": None,
                "failure_reason": "Invented unsupported record",
                "related_part": None,
                "parse_status": "unsupported",
                "available_page_evidence": [],
                "limitations": ["Invented unsupported record"],
            }
        )
    elif mismatch == "wrong_coverage_gaps":
        cast(list[JsonObject], response["coverage_gaps"]).append(
            {
                "reason": "Invented coverage gap",
                "object_ids": [],
            }
        )
    elif mismatch == "wrong_limitations":
        cast(list[str], response["limitations"]).append("Invented limitation")
    before = _database_rows(database_path)

    with pytest.raises(ProjectStoreError):
        store.save_read(baseline_id=baseline_id, require_current=True, task=task, response=response)

    assert _database_rows(database_path) == before
    assert store.list_reads(baseline_id) == []


def test_empty_and_later_page_deliveries_preserve_response_local_unread_coverage(
    store: ProjectStore,
) -> None:
    baseline_id = _baseline_id(_apply(store, _request()))
    result = read_docx(REGIONS_SOURCE)
    first = query_docx(
        result,
        ReadQuery(page_size=2),
        task_id="task-first-page",
        actor_id=ACTOR_ID,
        client_id="client-store-tests",
        baseline_id=baseline_id,
    )
    cursor = cast(str, cast(JsonObject, first["pagination"])["next_cursor"])
    queries = [
        ReadQuery(region="header", object_type="image"),
        ReadQuery(page_size=2, cursor=cursor),
    ]
    for index, query in enumerate(queries):
        response = query_docx(
            result,
            query,
            task_id=f"task-validated-delivery-{index}",
            actor_id=ACTOR_ID,
            client_id="client-store-tests",
            baseline_id=baseline_id,
        )
        response["project"] = {"project_id": PROJECT_ID, "baseline_id": baseline_id}
        receipt = cast(JsonObject, response["read_receipt"])
        task: JsonObject = {
            "task_id": receipt["task_id"],
            "baseline_id": baseline_id,
            "scope": response["query_scope"],
            "status": response["status"],
            "actual_read_ranges": receipt["ranges"],
            "unresolved_items": response["limitations"],
        }
        store.save_read(baseline_id=baseline_id, require_current=True, task=task, response=response)
        assert store.get_read(cast(str, receipt["read_record_id"])) == response
    assert len(store.list_reads(baseline_id)) == 2


def test_inconsistent_continuation_cursor_cannot_publish_a_read(
    store: ProjectStore, database_path: Path
) -> None:
    baseline_id = _baseline_id(_apply(store, _request()))
    response = query_docx(
        read_docx(REGIONS_SOURCE),
        ReadQuery(page_size=1),
        task_id="task-invalid-continuation",
        actor_id=ACTOR_ID,
        client_id="client-store-tests",
        baseline_id=baseline_id,
    )
    response["project"] = {"project_id": PROJECT_ID, "baseline_id": baseline_id}
    receipt = cast(JsonObject, response["read_receipt"])
    cast(JsonObject, response["pagination"])["next_cursor"] = "unrelated-cursor"
    cast(JsonObject, receipt["pagination"])["next_cursor"] = "unrelated-cursor"
    task: JsonObject = {
        "task_id": receipt["task_id"],
        "baseline_id": baseline_id,
        "scope": response["query_scope"],
        "status": response["status"],
        "actual_read_ranges": receipt["ranges"],
        "unresolved_items": response["limitations"],
    }
    before = _database_rows(database_path)

    with pytest.raises(ProjectStoreError, match="continuation cursor"):
        store.save_read(baseline_id=baseline_id, require_current=True, task=task, response=response)

    assert _database_rows(database_path) == before


@pytest.mark.parametrize(
    "field,value",
    [
        ("baseline_id", "baseline-phantom"),
        ("project_id", "project-another"),
        ("artifact_version_ids", ["artifact-version-" + "0" * 64]),
        ("artifact_version_ids", []),
        ("source_sha256", "0" * 64),
    ],
)
def test_baseline_payload_cannot_disagree_with_authoritative_sql_identity(
    store: ProjectStore, database_path: Path, field: str, value: object
) -> None:
    baseline_id = _baseline_id(_apply(store, _request()))
    with closing(sqlite3.connect(database_path)) as connection, connection:
        row = connection.execute(
            "SELECT payload FROM baseline WHERE baseline_id=?", (baseline_id,)
        ).fetchone()
        record = decode_json_object(row[0])
        record[field] = value
        connection.execute(
            "UPDATE baseline SET payload=? WHERE baseline_id=?",
            (encode_json_object(record), baseline_id),
        )
    before = _database_rows(database_path)

    for operation in (
        store.get_baseline,
        lambda: store.get_baseline(baseline_id),
        store.list_baselines,
    ):
        with pytest.raises(ProjectStoreError):
            operation()
    with (
        pytest.raises(ProjectStoreError),
        store.guard_baseline("baseline-phantom" if field == "baseline_id" else baseline_id),
    ):
        pytest.fail("An inconsistent baseline must never enter the guarded submission")

    assert _database_rows(database_path) == before
    assert store.info()["current_baseline_id"] == baseline_id


@pytest.mark.parametrize("damage", ["missing_artifact", "corrupt_content", "changed_digest"])
def test_baseline_reads_verify_the_bound_artifact_before_exposing_a_version(
    store: ProjectStore, database_path: Path, damage: str
) -> None:
    request = _request()
    baseline_id = _baseline_id(_apply(store, request))
    with closing(sqlite3.connect(database_path)) as connection, connection:
        if damage == "missing_artifact":
            connection.execute(
                "DELETE FROM artifact WHERE version_id=?", (request.artifact_version_id,)
            )
        elif damage == "corrupt_content":
            connection.execute("UPDATE artifact SET content=?", (b"corrupt",))
        else:
            connection.execute("UPDATE artifact SET sha256=?", ("0" * 64,))
    before = _database_rows(database_path)
    with pytest.raises(ProjectStoreError):
        store.get_baseline(baseline_id)
    with pytest.raises(ProjectStoreError):
        store.list_baselines()
    assert _database_rows(database_path) == before


def test_missing_current_baseline_target_is_reported_as_pointer_corruption(
    store: ProjectStore, database_path: Path
) -> None:
    baseline_id = _baseline_id(_apply(store, _request()))
    with closing(sqlite3.connect(database_path)) as connection, connection:
        connection.execute("DELETE FROM baseline WHERE baseline_id=?", (baseline_id,))
    with pytest.raises(ProjectStoreError, match="Current baseline pointer references a missing"):
        store.get_baseline()
    with (
        pytest.raises(ProjectStoreError, match="Current baseline pointer references a missing"),
        store.guard_baseline(baseline_id),
    ):
        pytest.fail("Missing baseline must not enter the guard")
