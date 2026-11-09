"""Public project workflows, immutable recovery and author input boundaries."""

import importlib
import json
import os
import sqlite3
from pathlib import Path

import pytest

from research_file_workbench.common.filesystem import snapshot_directory
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.docx.query import ReadQuery, ReadQueryError
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.projects.cli import main
from research_file_workbench.projects.models import BaselineConflictError, ProjectStoreError
from research_file_workbench.projects.service import (
    catalog_project,
    create_project,
    import_captured_document,
    import_document,
    inspect_import,
    open_project,
    read_project,
)

ROOT = Path(__file__).resolve().parents[2]
SOURCE_A = ROOT / "tests/fixtures/docx/normal/s1-regions-fields/s1-regions-fields.docx"
SOURCE_B = ROOT / "tests/fixtures/docx/normal/s1-figures-tables/s1-figures-tables.docx"


@pytest.fixture
def project(tmp_path):
    author = tmp_path / "author"
    author.mkdir()
    source = author / "source.docx"
    source.write_bytes(SOURCE_A.read_bytes())
    root = tmp_path / "persistent-project"
    create_project(root, author_workspace_root=author, project_id="project-test")
    return root, author, source


def apply_source(project, *, request_id="request-initial", expected=None):
    root, _, source = project
    return import_document(
        root,
        source,
        source_sha256=sha256_file(source),
        request_id=request_id,
        expected_baseline_id=expected,
        actor_id="operator-test",
        confirmation_reason="Import the specifically inspected manuscript version",
    )


def test_import_query_restart_and_history_preserve_author_inputs(project):
    root, author, source = project
    before = snapshot_directory(author)
    decision = apply_source(project)
    baseline_a = decision["result_baseline_id"]
    first = read_project(root, ReadQuery(region="body", object_type="text_block", page_size=2))
    receipt_id = first["read_receipt"]["read_record_id"]
    second = read_project(
        root,
        ReadQuery(
            region="body",
            object_type="text_block",
            page_size=2,
            cursor=first["pagination"]["next_cursor"],
        ),
    )
    assert not (
        {item["object_id"] for item in first["items"]}
        & {item["object_id"] for item in second["items"]}
    )
    assert open_project(root).get_read(receipt_id) == first
    assert snapshot_directory(author) == before
    source.write_bytes(SOURCE_B.read_bytes())
    update = apply_source(project, request_id="request-update", expected=baseline_a)
    assert update["status"] == "APPLIED"
    assert open_project(root).get_read(receipt_id) == first
    assert len(open_project(root).list_baselines()) == 2
    old = open_project(root).list_evidence(baseline_a, reader_version=READER_VERSION)
    assert old and all(item["applicability_to_current_baseline"] == "STALE" for item in old)
    assert all(item["verification_status"] == "NOT_REVIEWED" for item in old)
    historical = read_project(
        root, ReadQuery(object_type="text_block", page_size=1), baseline_id=baseline_a
    )
    assert historical["project"]["baseline_is_current"] is False
    assert historical["source"] == first["source"]


def test_same_request_replay_survives_missing_original_and_new_current_baseline(project):
    root, _, source = project
    digest_a = sha256_file(source)
    first = apply_source(project)
    source.write_bytes(SOURCE_B.read_bytes())
    apply_source(project, request_id="request-update", expected=first["result_baseline_id"])
    source.unlink()
    replay = import_document(
        root,
        source,
        source_sha256=digest_a,
        request_id="request-initial",
        expected_baseline_id=None,
        actor_id="operator-test",
        confirmation_reason="Recover result",
    )
    assert replay == first
    assert len(open_project(root).list_baselines()) == 2


def test_catalog_and_preview_do_not_count_as_content_reads(project):
    root, _, source = project
    preview = inspect_import(root, source)
    assert preview["verification_status"] == "NOT_REVIEWED"
    assert open_project(root).info()["current_baseline_id"] is None
    apply_source(project)
    catalog = catalog_project(root)
    assert "read_receipt" not in catalog
    assert open_project(root).list_reads() == []


def test_source_change_after_inspection_refuses_without_baseline(project):
    root, _, source = project
    preview = inspect_import(root, source)
    source.write_bytes(SOURCE_B.read_bytes())
    result = import_document(
        root,
        source,
        source_sha256=preview["source_sha256"],
        request_id="request-drift",
        expected_baseline_id=None,
        actor_id="operator-test",
        confirmation_reason="Test drift",
    )
    assert result["status"] == "REJECTED"
    assert open_project(root).list_baselines() == []
    source.write_bytes(SOURCE_A.read_bytes())
    assert apply_source(project, request_id="request-drift") == result


def test_same_bytes_rebaseline_invalidates_project_cursor(project):
    root, _, _ = project
    initial = apply_source(project)
    first = read_project(root, ReadQuery(page_size=1))
    apply_source(project, request_id="request-same-bytes", expected=initial["result_baseline_id"])
    with pytest.raises(ReadQueryError, match="Cursor"):
        read_project(root, ReadQuery(page_size=1, cursor=first["pagination"]["next_cursor"]))
    assert len(open_project(root).list_reads()) == 1


def test_current_read_racing_baseline_update_does_not_persist_wrong_task(project, monkeypatch):
    root, _, source = project
    initial = apply_source(project)
    module = importlib.import_module("research_file_workbench.projects.service")
    real_query = module.query_docx

    def racing_query(*args, **kwargs):
        result = real_query(*args, **kwargs)
        source.write_bytes(SOURCE_B.read_bytes())
        apply_source(project, request_id="request-race", expected=initial["result_baseline_id"])
        return result

    monkeypatch.setattr(module, "query_docx", racing_query)
    with pytest.raises(BaselineConflictError):
        read_project(root, ReadQuery(page_size=1))
    assert open_project(root).list_reads() == []


def test_historical_read_current_flag_is_fixed_at_commit(project, monkeypatch):
    root, _, source = project
    initial = apply_source(project)
    module = importlib.import_module("research_file_workbench.projects.service")
    original_context = module._project_context

    def racing_context(store, baseline):
        sampled = original_context(store, baseline)
        source.write_bytes(SOURCE_B.read_bytes())
        apply_source(
            project, request_id="request-history-race", expected=initial["result_baseline_id"]
        )
        return sampled

    monkeypatch.setattr(module, "_project_context", racing_context)
    response = read_project(root, ReadQuery(page_size=1), baseline_id=initial["result_baseline_id"])
    assert response["project"]["baseline_is_current"] is False
    assert open_project(root).get_read(response["read_receipt"]["read_record_id"]) == response


def test_source_blob_corruption_before_delivery_cannot_publish_read(project, monkeypatch):
    root, _, _ = project
    apply_source(project)
    module = importlib.import_module("research_file_workbench.projects.service")
    original_query = module.query_docx

    def corrupt_after_query(*args, **kwargs):
        response = original_query(*args, **kwargs)
        with sqlite3.connect(root / "project.sqlite3") as connection:
            connection.execute("UPDATE artifact SET content=?", (b"corrupted-source",))
        return response

    monkeypatch.setattr(module, "query_docx", corrupt_after_query)
    with pytest.raises(ProjectStoreError, match="immutable version"):
        read_project(root, ReadQuery(page_size=1))
    assert open_project(root).list_reads() == []


def test_page_query_is_explicitly_unsupported_in_project_store(project):
    root, _, _ = project
    apply_source(project)
    with pytest.raises(ProjectStoreError, match="registered render"):
        read_project(root, ReadQuery(page_number=1))
    assert open_project(root).list_reads() == []


def test_project_cannot_be_created_inside_or_above_author_root(tmp_path):
    author = tmp_path / "author"
    author.mkdir()
    for target in (author / "project", tmp_path):
        with pytest.raises(ProjectStoreError, match="overlap"):
            create_project(target, author_workspace_root=author)
    assert list(author.iterdir()) == []


def test_existing_project_cannot_be_reinitialized(project):
    root, author, _ = project
    initial = apply_source(project)
    with pytest.raises(FileExistsError):
        create_project(root, author_workspace_root=author)
    assert open_project(root).info()["current_baseline_id"] == initial["result_baseline_id"]


def test_invalid_project_identity_does_not_publish_half_initialized_directory(tmp_path):
    author = tmp_path / "author"
    author.mkdir()
    root = tmp_path / "project"
    with pytest.raises(ProjectStoreError):
        create_project(root, author_workspace_root=author, project_id="../outside")
    assert not root.exists()
    assert list(tmp_path.glob(".rfw-project-*")) == []


def test_wrong_source_location_cannot_enter_project(project, tmp_path):
    root, _, _ = project
    outside = tmp_path / "outside.docx"
    outside.write_bytes(SOURCE_A.read_bytes())
    result = import_document(
        root,
        outside,
        source_sha256=sha256_file(outside),
        request_id="request-outside",
        expected_baseline_id=None,
        actor_id="operator-test",
        confirmation_reason="Test boundary",
    )
    assert result["status"] == "REJECTED"
    assert open_project(root).list_baselines() == []


def test_unparseable_source_does_not_publish_baseline(project):
    root, _, source = project
    source.write_bytes(b"not a document")
    result = apply_source(project)
    assert result["status"] == "REJECTED"
    assert open_project(root).info()["current_baseline_id"] is None
    assert open_project(root).get_request("operator-test", "request-initial")["result"] == result


def test_database_hardlink_cannot_modify_author_workspace(project):
    root, author, _ = project
    os.link(root / "project.sqlite3", author / "shared.sqlite3")
    before = snapshot_directory(author)
    with pytest.raises(ProjectStoreError, match="hard links"):
        apply_source(project)
    assert snapshot_directory(author) == before


def test_sqlite_journal_symlink_cannot_write_to_author_workspace(project):
    root, author, _ = project
    source = author / "must-stay.txt"
    source.write_text("author", encoding="utf-8")
    try:
        (root / "project.sqlite3-journal").symlink_to(source)
    except OSError:
        pytest.skip("Symlinks are unavailable")
    with pytest.raises(ValueError, match="Reparse-point"):
        open_project(root)
    assert source.read_text(encoding="utf-8") == "author"


def test_cli_end_to_end_without_manually_locating_a_run(project, capsys):
    root, _, source = project
    prefix = ["--project-root", str(root)]
    assert main([*prefix, "inspect-import", str(source)]) == 0
    preview = json.loads(capsys.readouterr().out)
    assert (
        main(
            [
                *prefix,
                "import",
                str(source),
                "--source-sha256",
                preview["source_sha256"],
                "--request-id",
                "request-cli",
                "--initial",
                "--actor-id",
                "operator-cli",
                "--reason",
                "Use the inspected source version",
            ]
        )
        == 0
    )
    assert json.loads(capsys.readouterr().out)["status"] == "APPLIED"
    assert main([*prefix, "read", "--object-type", "text_block", "--page-size", "1"]) == 1
    response = json.loads(capsys.readouterr().out)
    assert main([*prefix, "response", response["read_receipt"]["read_record_id"]]) == 1
    assert json.loads(capsys.readouterr().out) == response


def test_persistent_store_remains_usable_without_author_source(project):
    root, _, source = project
    apply_source(project)
    source.unlink()
    response = read_project(root, ReadQuery(object_type="text_block", page_size=1))
    assert response["items"]
    with sqlite3.connect(root / "project.sqlite3") as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


@pytest.mark.parametrize("filename", ["source.txt", "source", "source.docx.txt"])
def test_captured_document_rejects_non_docx_filename_without_publishing(project, filename):
    root, _, _ = project
    with pytest.raises(ProjectStoreError, match="DOCX"):
        import_captured_document(
            root,
            SOURCE_A.read_bytes(),
            filename=filename,
            request_id="request-invalid-extension",
            expected_baseline_id="baseline-missing",
            confirmation_reason="Reject a non-DOCX upload",
        )
    store = open_project(root)
    assert store.info()["current_baseline_id"] is None
    assert store.list_baselines() == []


@pytest.mark.parametrize("filename", ["..\\source.docx", "nested/source.docx", "C:\\source.docx"])
def test_captured_document_rejects_path_like_filename_without_publishing(project, filename):
    root, _, _ = project
    with pytest.raises(ProjectStoreError, match="DOCX"):
        import_captured_document(
            root,
            SOURCE_A.read_bytes(),
            filename=filename,
            request_id="request-invalid-name",
            expected_baseline_id="baseline-missing",
            confirmation_reason="Reject a path-like upload label",
        )
    assert open_project(root).list_baselines() == []


def test_captured_document_records_parse_failure_without_publishing(project):
    root, _, _ = project
    result = import_captured_document(
        root,
        b"not a DOCX package",
        filename="broken.docx",
        request_id="request-captured-parse-failure",
        expected_baseline_id="baseline-missing",
        confirmation_reason="Retain the failed upload attempt for audit",
    )
    assert result["status"] == "REJECTED"
    assert open_project(root).info()["current_baseline_id"] is None
    assert (
        open_project(root).get_request("local-operator", "request-captured-parse-failure")["result"]
        == result
    )
