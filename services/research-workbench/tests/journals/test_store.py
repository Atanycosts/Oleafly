"""Library transactions preserve source versions, explicit bindings and check conclusions."""

import os
import shutil
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path

import pytest

from research_file_workbench.common.filesystem import PathBoundaryError, snapshot_directory
from research_file_workbench.common.hashing import sha256_text
from research_file_workbench.common.json_io import encode_json_object
from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.journals.analysis import analyze_world
from research_file_workbench.journals.checker import check_world
from research_file_workbench.journals.models import (
    SourceInput,
    world_version_id,
)
from research_file_workbench.journals.store import (
    BindingConflictError,
    WorldStore,
    WorldStoreError,
)
from tests.journals.test_analysis import template_bytes


def world_input(
    content=b"All manuscript pages must use 2 columns.", journal_id="journal-test", **changes
):
    source = SourceInput("guide.txt", "guide_text", content)
    world = analyze_world(journal_id, "Test journal", [source])
    world.update(changes)
    world["version_id"] = world_version_id(world)
    return world, {source.source_id: content}


@pytest.fixture
def store(tmp_path):
    author = tmp_path / "author"
    author.mkdir()
    return WorldStore.create(tmp_path / "library", protected_roots=(author,))


def bind(store, world, tmp_path, *, expected=None, baseline="baseline-one"):
    return store.bind_project(
        "project-test",
        str((tmp_path / "project").resolve()),
        baseline,
        world["version_id"],
        expected_binding_id=expected,
        actor_id="operator-test",
        surface="cli",
    )


def check_input(store, binding, check_id="check-test"):
    world = store.get_world(binding["world_version_id"])
    observed = read_docx_bytes(template_bytes(), source_label="retained-test-manuscript")
    checked = check_world(world, observed)
    return {
        **checked,
        "check_id": check_id,
        "project_id": binding["project_id"],
        "baseline_id": binding["baseline_id"],
        "binding_id": binding["binding_id"],
        "reader_version": READER_VERSION,
        "dependencies": {
            "artifact_version_id": f"artifact-version-{observed.source_sha256}",
            "source_sha256": observed.source_sha256,
            "world_version_id": world["version_id"],
            "reader_version": READER_VERSION,
            "checker_version": checked["checker_version"],
            "completeness": "complete_for_declared_section_geometry",
        },
    }


def counts(store):
    with sqlite3.connect(store.database_path) as connection:
        return {
            name: connection.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
            for name in (
                "source",
                "world",
                "world_source",
                "binding",
                "project_binding",
                "check_record",
                "disposition",
            )
        }


def test_constructor_never_creates_a_library(tmp_path):
    library = tmp_path / "missing"
    store = WorldStore(library)
    assert not library.exists()
    with pytest.raises(WorldStoreError, match="initialize"):
        store.list_worlds()
    assert not library.exists()


def test_library_validation_checks_boundaries_without_loading_worlds(store):
    world, sources = world_input()
    store.save_world(world, sources)
    with sqlite3.connect(store.database_path) as connection:
        connection.execute("UPDATE world SET payload=?", ('{"damaged":true}',))
    assert store.validate_library() is None
    with pytest.raises(WorldStoreError, match="content changed"):
        store.get_world(world["version_id"])


def test_world_sources_and_versions_survive_reopen_and_retry(store):
    world, sources = world_input()
    first = store.save_world(world, sources)
    assert first["version_ordinal"] == 1
    second_world, second_sources = world_input(b"The page width must be 215 mm.")
    second = store.save_world(second_world, second_sources)
    assert second["version_ordinal"] == 2
    other_world, other_sources = world_input(journal_id="another-journal")
    assert store.save_world(other_world, other_sources)["version_ordinal"] == 1
    reopened = WorldStore(store.root)
    assert reopened.save_world(deepcopy(world), sources) == first
    assert reopened.get_world(first["version_id"]) == first
    source_id = next(iter(sources))
    assert reopened.read_source(source_id) == sources[source_id]
    assert len(reopened.list_worlds()) == 3
    assert counts(store)["source"] == 2
    assert all(item["journal_name"] == "Test journal" for item in reopened.list_worlds())
    assert all("name" not in item for item in reopened.list_worlds())


def test_same_bytes_in_two_roles_retain_one_source(store):
    content = b"All manuscript pages must use 2 columns."
    first = SourceInput("guide.txt", "guide_text", content)
    second = SourceInput("guide-copy.txt", "guide_text", content)
    world = analyze_world("journal-test", "Test journal", [first, second])
    store.save_world(world, {first.source_id: content})
    assert counts(store)["source"] == counts(store)["world_source"] == 1


def test_wrong_source_hash_or_world_identity_cannot_publish_any_record(store):
    world, sources = world_input()
    before = counts(store)
    with pytest.raises(WorldStoreError, match="declared hash"):
        store.save_world(world, {next(iter(sources)): b"different"})
    assert counts(store) == before
    changed = {**world, "journal_name": "Changed without changing identity"}
    with pytest.raises(ValueError):
        store.save_world(changed, sources)
    assert counts(store) == before


def test_failed_world_commit_rolls_back_captured_source(store):
    world, sources = world_input()
    with sqlite3.connect(store.database_path) as connection:
        connection.execute(
            "CREATE TRIGGER reject_world BEFORE INSERT ON world "
            "BEGIN SELECT RAISE(ABORT,'world insert refused'); END"
        )
    with pytest.raises(WorldStoreError, match="world insert refused"):
        store.save_world(world, sources)
    assert counts(store)["source"] == counts(store)["world"] == 0


def test_concurrent_same_world_commit_is_idempotent(store):
    world, sources = world_input()
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(WorldStore(store.root).save_world, world, sources) for _ in range(2)
        ]
        results = [future.result(timeout=15) for future in futures]
    assert results[0] == results[1]
    assert counts(store)["world"] == 1


def test_competing_bindings_obey_compare_and_swap(store, tmp_path):
    first_world, sources = world_input()
    store.save_world(first_world, sources)
    first = bind(store, first_world, tmp_path)
    second_world, sources = world_input(b"The page width must be 212 mm.")
    third_world, third_sources = world_input(b"The page width must be 216 mm.")
    store.save_world(second_world, sources)
    store.save_world(third_world, third_sources)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(
                bind, WorldStore(store.root), world, tmp_path, expected=first["binding_id"]
            )
            for world in (second_world, third_world)
        ]
        results = []
        for future in futures:
            try:
                results.append(future.result(timeout=15))
            except BindingConflictError:
                results.append("conflict")
    assert results.count("conflict") == 1
    applied = next(result for result in results if isinstance(result, dict))
    assert store.get_binding("project-test") == applied
    assert len(store.list_bindings("project-test")) == 2
    assert not (tmp_path / "project").exists()


def test_same_binding_scope_replays_without_another_history_record(store, tmp_path):
    world, sources = world_input()
    store.save_world(world, sources)
    first = bind(store, world, tmp_path)
    assert bind(store, world, tmp_path) == first
    assert counts(store)["binding"] == 1


def test_same_scope_does_not_bypass_unrelated_expected_binding(store, tmp_path):
    world, sources = world_input()
    store.save_world(world, sources)
    first = bind(store, world, tmp_path)
    second = bind(store, world, tmp_path, expected=first["binding_id"], baseline="baseline-two")
    assert (
        bind(store, world, tmp_path, expected=first["binding_id"], baseline="baseline-two")
        == second
    )
    assert (
        bind(store, world, tmp_path, expected=second["binding_id"], baseline="baseline-two")
        == second
    )
    before = counts(store)
    with pytest.raises(BindingConflictError):
        bind(store, world, tmp_path, expected=None, baseline="baseline-two")
    with pytest.raises(BindingConflictError):
        store.bind_project(
            "project-test",
            str((tmp_path / "project").resolve()),
            "baseline-two",
            world["version_id"],
            expected_binding_id=first["binding_id"],
            actor_id="another-operator",
            surface="cli",
        )
    assert counts(store) == before


def test_failed_binding_pointer_update_keeps_old_binding_and_history(store, tmp_path):
    world, sources = world_input()
    store.save_world(world, sources)
    first = bind(store, world, tmp_path)
    before = counts(store)
    with sqlite3.connect(store.database_path) as connection:
        connection.execute(
            "CREATE TRIGGER reject_binding BEFORE UPDATE ON project_binding "
            "BEGIN SELECT RAISE(ABORT,'pointer refused'); END"
        )
    with pytest.raises(WorldStoreError, match="pointer refused"):
        bind(store, world, tmp_path, expected=first["binding_id"], baseline="baseline-two")
    assert store.get_binding("project-test") == first
    assert counts(store) == before


def test_new_check_requires_current_binding_but_retry_recovers_history(store, tmp_path):
    world, sources = world_input()
    store.save_world(world, sources)
    first_binding = bind(store, world, tmp_path)
    first_check = check_input(store, first_binding)
    assert store.save_check(first_check) == first_check
    bind(store, world, tmp_path, expected=first_binding["binding_id"], baseline="baseline-two")
    with pytest.raises(BindingConflictError):
        store.save_check(check_input(store, first_binding, "check-stale"))
    assert store.save_check(first_check) == first_check
    assert store.get_check("check-test") == first_check
    assert store.list_checks("project-test", binding_id=first_binding["binding_id"]) == [
        first_check
    ]
    with pytest.raises(WorldStoreError, match="different content"):
        store.save_check({**first_check, "checker_version": "checker-changed"})


@pytest.mark.parametrize(
    "mutation", ["rule_id", "verdict", "basis", "summary", "missing_rule", "coverage"]
)
def test_check_payload_cannot_fabricate_rule_source_verdict_or_summary(store, tmp_path, mutation):
    world, sources = world_input()
    store.save_world(world, sources)
    binding = bind(store, world, tmp_path)
    check = check_input(store, binding)
    first = check["rule_results"][0]
    if mutation == "rule_id":
        first["rule_id"] = "rule-another-world"
    elif mutation == "verdict":
        first["verdict"] = "compliant"
    elif mutation == "basis":
        first["basis_status"] = "candidate"
    elif mutation == "summary":
        check["summary"]["violation"] = 0
    elif mutation == "missing_rule":
        check["rule_results"] = []
    else:
        first["coverage"]["total_sections"] = 999
    before = counts(store)
    with pytest.raises(ValueError):
        store.save_check(check)
    assert counts(store) == before


@pytest.mark.parametrize(
    "field",
    [
        "artifact_version_id",
        "source_sha256",
        "world_version_id",
        "reader_version",
        "checker_version",
    ],
)
def test_new_check_dependencies_must_match_its_retained_identity(store, tmp_path, field):
    world, sources = world_input()
    store.save_world(world, sources)
    check = check_input(store, bind(store, world, tmp_path))
    check["dependencies"][field] = "different-version"
    with pytest.raises(WorldStoreError, match="dependencies differ"):
        store.save_check(check)
    assert store.list_checks() == []


def test_new_checks_reference_worlds_and_old_snapshots_cannot_substitute_rules(store, tmp_path):
    world, sources = world_input()
    retained = store.save_world(world, sources)
    check = check_input(store, bind(store, world, tmp_path))
    with pytest.raises(WorldStoreError, match="not duplicate"):
        store.save_check({**check, "world": retained})
    store.save_check(check)
    historical = {**check, "world": retained}
    payload = encode_json_object(historical)
    with sqlite3.connect(store.database_path) as connection:
        connection.execute(
            "UPDATE check_record SET payload=?,content_sha256=?", (payload, sha256_text(payload))
        )
    assert store.get_check(check["check_id"]) == historical
    historical["world"]["journal_name"] = "Changed embedded snapshot"
    payload = encode_json_object(historical)
    with sqlite3.connect(store.database_path) as connection:
        connection.execute(
            "UPDATE check_record SET payload=?,content_sha256=?", (payload, sha256_text(payload))
        )
    with pytest.raises(ValueError):
        store.get_check(check["check_id"])


@pytest.mark.parametrize(
    "field,value",
    [
        ("validity", "CURRENT"),
        ("stale_reasons", []),
        ("update_available", False),
        ("dispositions", []),
    ],
)
def test_new_check_refuses_derived_presentation_fields_without_changes(
    store, tmp_path, field, value
):
    world, sources = world_input()
    store.save_world(world, sources)
    check = check_input(store, bind(store, world, tmp_path))
    before = counts(store)
    with pytest.raises(WorldStoreError, match="must not persist derived"):
        store.save_check({**check, field: value})
    assert counts(store) == before
    assert store.list_checks() == []


def test_historical_derived_fields_are_retained_on_recovery_and_exact_replay(store, tmp_path):
    world, sources = world_input()
    store.save_world(world, sources)
    check = check_input(store, bind(store, world, tmp_path))
    store.save_check(check)
    historical = {
        **check,
        "validity": "CURRENT",
        "stale_reasons": [],
        "update_available": False,
        "dispositions": [],
    }
    payload = encode_json_object(historical)
    with sqlite3.connect(store.database_path) as connection:
        connection.execute(
            "UPDATE check_record SET payload=?,content_sha256=?", (payload, sha256_text(payload))
        )
    before = counts(store)
    assert store.get_check(check["check_id"]) == historical
    assert store.save_check(historical) == historical
    assert counts(store) == before


def test_rehashed_storage_payload_still_must_match_world_identity(store):
    world, sources = world_input()
    store.save_world(world, sources)
    changed = {**world, "journal_name": "Rehashed but wrong world identity"}
    payload = encode_json_object(changed)
    with sqlite3.connect(store.database_path) as connection:
        connection.execute(
            "UPDATE world SET payload=?,content_sha256=?", (payload, sha256_text(payload))
        )
    with pytest.raises(ValueError):
        store.get_world(world["version_id"])


def test_rehashed_world_cannot_invent_a_requirement_unsupported_by_retained_source(store):
    world, sources = world_input()
    world["rules"][0]["expected"] = 9
    world["version_id"] = world_version_id(world)
    before = counts(store)
    with pytest.raises(ValueError):
        store.save_world(world, sources)
    assert counts(store) == before


def test_missing_binding_target_is_corruption_not_an_unbound_project(store, tmp_path):
    world, sources = world_input()
    store.save_world(world, sources)
    binding = bind(store, world, tmp_path)
    with sqlite3.connect(store.database_path) as connection:
        connection.execute("DELETE FROM binding WHERE binding_id=?", (binding["binding_id"],))
    with pytest.raises(WorldStoreError, match="does not exist"):
        store.get_binding("project-test")


def test_deleted_world_source_relation_is_not_repaired_by_idempotent_retry(store):
    world, sources = world_input()
    store.save_world(world, sources)
    with sqlite3.connect(store.database_path) as connection:
        connection.execute("DELETE FROM world_source")
    with pytest.raises(WorldStoreError, match="source links"):
        store.get_world(world["version_id"])
    with pytest.raises(WorldStoreError, match="source links"):
        store.save_world(world, sources)


def test_world_and_check_recovery_detect_source_corruption(store, tmp_path):
    world, sources = world_input()
    store.save_world(world, sources)
    binding = bind(store, world, tmp_path)
    check = check_input(store, binding)
    store.save_check(check)
    with sqlite3.connect(store.database_path) as connection:
        connection.execute("UPDATE source SET content=?", (b"damaged",))
    for operation in (
        lambda: store.get_world(world["version_id"]),
        store.list_worlds,
        lambda: store.get_check(check["check_id"]),
        store.list_checks,
    ):
        with pytest.raises(WorldStoreError, match="immutable identity"):
            operation()


def test_retained_world_and_check_remain_readable_after_method_upgrade(
    store, tmp_path, monkeypatch
):
    from research_file_workbench.journals import models

    world, sources = world_input()
    saved_world = store.save_world(world, sources)
    binding = bind(store, world, tmp_path)
    check = check_input(store, binding)
    saved_check = store.save_check(check)
    monkeypatch.setattr(models, "ANALYZER_VERSION", "journal-world-analyzer-future")
    monkeypatch.setattr(models, "CHECKER_VERSION", "journal-geometry-checker-future")
    assert store.get_world(world["version_id"]) == saved_world
    assert store.save_world(world, sources) == saved_world
    assert store.get_check(check["check_id"]) == saved_check
    assert store.save_check(check) == saved_check


def test_new_check_refuses_obsolete_world_analysis_without_changing_history(
    store, tmp_path, monkeypatch
):
    from research_file_workbench.journals import models

    world, sources = world_input()
    store.save_world(world, sources)
    check = check_input(store, bind(store, world, tmp_path))
    retained = store.save_check(check)
    pending = {**check, "check_id": "check-after-analysis-upgrade"}
    before = counts(store)
    monkeypatch.setattr(models, "ANALYZER_VERSION", "journal-world-analyzer-future")

    with pytest.raises(models.WorldAnalysisError, match="reanalyze"):
        store.save_check(pending)
    assert counts(store) == before
    assert store.get_check(check["check_id"]) == retained
    assert store.save_check(check) == retained


def test_dispositions_preserve_verdict_and_cannot_claim_resolution(store, tmp_path):
    world, sources = world_input()
    store.save_world(world, sources)
    binding = bind(store, world, tmp_path)
    check = check_input(store, binding)
    store.save_check(check)
    rule_id = check["rule_results"][0]["rule_id"]
    note = store.record_disposition(
        "check-test", rule_id, "note", "Reviewer comment", "operator-test", surface="cli"
    )
    deferred = store.record_disposition(
        "check-test", rule_id, "defer", "Await source review", "operator-test", surface="cli"
    )
    assert note["verdict"] == deferred["verdict"] == "violation"
    assert store.get_check("check-test") == check
    assert store.list_dispositions("check-test") == [note, deferred]
    with pytest.raises(WorldStoreError, match="note or defer"):
        store.record_disposition(
            "check-test", rule_id, "resolved", "Override", "operator-test", surface="cli"
        )
    with pytest.raises(WorldStoreError, match="does not belong"):
        store.record_disposition(
            "check-test", "another-rule", "note", "Comment", "operator-test", surface="cli"
        )
    assert len(store.list_dispositions("check-test")) == 2


def test_corrupted_retained_content_is_refused(store):
    world, sources = world_input()
    store.save_world(world, sources)
    source_id = next(iter(sources))
    with sqlite3.connect(store.database_path) as connection:
        connection.execute("UPDATE source SET content=?", (b"corrupt",))
    with pytest.raises(WorldStoreError, match="immutable identity"):
        store.read_source(source_id)
    with sqlite3.connect(store.database_path) as connection:
        connection.execute("UPDATE world SET payload=?", ('{"changed":true}',))
    with pytest.raises(WorldStoreError, match="content changed"):
        store.get_world(world["version_id"])


def test_protected_roots_are_persisted_and_rechecked_after_relocation(store, tmp_path):
    author = tmp_path / "author"
    before = snapshot_directory(author)
    for forbidden in (author / "library", tmp_path):
        with pytest.raises(WorldStoreError, match="must not overlap"):
            WorldStore.create(forbidden, protected_roots=(author,))
    assert snapshot_directory(author) == before
    relocated = author / "copied-library"
    shutil.copytree(store.root, relocated)
    copied_before = snapshot_directory(relocated)
    with pytest.raises(WorldStoreError, match="must not overlap"):
        WorldStore(relocated).list_worlds()
    assert snapshot_directory(relocated) == copied_before


def test_library_reinitialization_cannot_replace_existing_data(store):
    world, sources = world_input()
    saved = store.save_world(world, sources)
    with pytest.raises(FileExistsError):
        WorldStore.create(store.root)
    assert store.get_world(world["version_id"]) == saved


def test_hardlinked_database_is_refused_before_any_write(store, tmp_path):
    os.link(store.database_path, tmp_path / "author/shared.sqlite3")
    before = snapshot_directory(tmp_path / "author")
    with pytest.raises(WorldStoreError, match="hard links"):
        store.save_world(*world_input())
    assert snapshot_directory(tmp_path / "author") == before


def test_reparse_library_or_journal_is_refused(store, tmp_path):
    linked = tmp_path / "linked-library"
    try:
        linked.symlink_to(store.root, target_is_directory=True)
    except OSError:
        pytest.skip("Symlinks are unavailable")
    with pytest.raises(PathBoundaryError, match="Reparse-point"):
        WorldStore(linked).list_worlds()
    protected = tmp_path / "author/protected.txt"
    protected.write_text("keep", encoding="utf-8")
    Path(str(store.database_path) + "-journal").symlink_to(protected)
    with pytest.raises(PathBoundaryError, match="Reparse-point"):
        store.list_worlds()
    assert protected.read_text(encoding="utf-8") == "keep"
