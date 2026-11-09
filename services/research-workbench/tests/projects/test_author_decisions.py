"""Author decisions are explicit, versioned, and refuse what they cannot yet hold.

Section 3.3.1 allows a decision only on a trusted user confirmation, keeps an update as a new
version rather than a rewrite, and opens its five scopes in different stages. These tests pin the
storage rules, the in-place schema upgrade that carries them, and the refusals that keep a decision
from claiming a scope or an origin it does not have.
"""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any, cast

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.projects import project_database
from research_file_workbench.projects.author_decision_records import (
    DECISION_KINDS,
    DECISION_SCOPES,
    EXPRESSION_PREFERENCE,
    OPEN_SCOPES,
    RESEARCH_BOUNDARY,
    AuthorDecisionRequest,
)
from research_file_workbench.projects.models import BaselineRequest, ProjectStoreError
from research_file_workbench.projects.store import ProjectStore

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SOURCE = (
    PROJECT_ROOT / "tests" / "fixtures" / "docx" / "normal/s1-regions-fields/s1-regions-fields.docx"
)
PROJECT_ID = "project-decision-tests"
ACTOR_ID = "operator-decision-tests"


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


def _decision(**overrides: Any) -> AuthorDecisionRequest:
    fields: dict[str, Any] = {
        "decision_key": "preferred-term-mvcc",
        "kind": EXPRESSION_PREFERENCE,
        "content": "Write MVCC conflict rather than concurrency failure.",
        "scope": "PROJECT",
        "applies_to": "Every manuscript in this project.",
        "confirmed_source": "local_operator",
        "reason": "The author confirmed this term against the reviewer note.",
        "invalidation": "The target journal publishes a different term for this concept.",
    }
    fields.update(overrides)
    return AuthorDecisionRequest(**fields)


def _rows(database_path: Path) -> dict[str, list[tuple[object, ...]]]:
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


def _revert_to_version_1(database_path: Path) -> None:
    """Leave the database in the shape the earlier build wrote, with its rows intact."""
    with closing(sqlite3.connect(database_path)) as connection, connection:
        connection.execute("DROP INDEX author_decision_key")
        connection.execute("DROP TABLE author_decision")
        connection.execute("PRAGMA user_version = 1")


def _apply_source(store: ProjectStore) -> str:
    request = BaselineRequest(
        project_id=PROJECT_ID,
        actor_id=ACTOR_ID,
        request_id="request-decision-source",
        expected_baseline_id=None,
        source_sha256=sha256_bytes(SOURCE.read_bytes()),
    )
    result = store.apply_baseline(
        request,
        source_bytes=SOURCE.read_bytes(),
        source_path=SOURCE.resolve().as_posix(),
        confirmation_reason="Confirmed this fixture as the project's reading source.",
        evidence=[
            {
                "evidence_id": "evidence-decision-source",
                "evidence_version": "evidence-version-decision-source",
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
        ],
        reader_version=READER_VERSION,
    )
    return cast(str, result["result_baseline_id"])


def test_a_version_1_project_is_upgraded_in_place_and_keeps_its_rows(
    store: ProjectStore, database_path: Path
) -> None:
    baseline_id = _apply_source(store)
    _revert_to_version_1(database_path)
    before = _rows(database_path)
    assert "author_decision" not in before

    reopened = ProjectStore(database_path)

    assert reopened.info()["project_id"] == PROJECT_ID
    assert reopened.get_baseline(baseline_id)["baseline_id"] == baseline_id
    after = _rows(database_path)
    assert "author_decision" in after
    for table, rows in before.items():
        assert after[table] == rows, table
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 2


def test_a_newer_storage_version_is_refused_instead_of_interpreted(
    store: ProjectStore, database_path: Path
) -> None:
    with closing(sqlite3.connect(database_path)) as connection, connection:
        connection.execute("PRAGMA user_version = 99")

    with pytest.raises(ProjectStoreError, match="Unsupported project storage version"):
        ProjectStore(database_path).info()


def test_an_opener_holding_the_old_version_survives_another_opener_upgrading_it(
    store: ProjectStore, database_path: Path
) -> None:
    """A second opener waits for the migration lock and finds the upgrade already applied."""
    _revert_to_version_1(database_path)
    with closing(sqlite3.connect(database_path)) as stale:
        stale.execute("PRAGMA busy_timeout = 5000")
        assert stale.execute("PRAGMA user_version").fetchone()[0] == 1
        ProjectStore(database_path).info()

        # The same gate `connect_project` runs, with the version read before the upgrade committed.
        project_database._migrate(stale, 1)

        assert stale.execute("PRAGMA user_version").fetchone()[0] == 2
    assert ProjectStore(database_path).list_author_decisions() == []


def test_a_saved_decision_records_every_declared_field(store: ProjectStore) -> None:
    saved = store.save_author_decision(
        _decision(
            kind=RESEARCH_BOUNDARY,
            scope="DOCUMENT",
            conditions="Applies while the ablation table stays the only evidence.",
            rule_refs=("ijam-figures-1",),
            evidence_refs=("evidence-version-decision-source",),
            confirmed_at="2026-10-06T09:00:00Z",
        )
    )

    assert saved["decision_id"] == "preferred-term-mvcc-v1"
    assert saved["version"] == 1
    assert saved["supersedes"] is None
    assert saved["baseline_id"] is None
    assert saved["confirmed_source"] == "local_operator"
    assert saved["confirmed_at"] == "2026-10-06T09:00:00Z"
    assert saved["kind"] == RESEARCH_BOUNDARY
    assert saved["scope"] == "DOCUMENT"
    assert saved["conditions"] == "Applies while the ablation table stays the only evidence."
    assert saved["rule_refs"] == ["ijam-figures-1"]
    assert saved["evidence_refs"] == ["evidence-version-decision-source"]
    assert store.get_author_decision("preferred-term-mvcc-v1") == saved


def test_an_update_appends_a_version_and_keeps_the_one_it_replaces(
    store: ProjectStore,
) -> None:
    first = store.save_author_decision(_decision(content="Write MVCC conflict."))
    second = store.save_author_decision(_decision(content="Write MVCC conflict, never MVCC clash."))

    assert first["decision_id"] == "preferred-term-mvcc-v1"
    assert second["decision_id"] == "preferred-term-mvcc-v2"
    assert second["supersedes"] == first["decision_id"]
    assert second["version"] == 2
    assert store.get_author_decision(first["decision_id"]) == first
    assert store.list_author_decisions() == [second]


def test_listing_returns_the_current_version_of_each_key_in_commit_order(
    store: ProjectStore,
) -> None:
    alpha = store.save_author_decision(_decision(decision_key="alpha-term"))
    beta = store.save_author_decision(_decision(decision_key="beta-term"))
    revised = store.save_author_decision(_decision(decision_key="alpha-term", content="Revised."))

    assert store.list_author_decisions() == [beta, revised]
    assert store.list_author_decisions(latest_only=False) == [alpha, beta, revised]
    assert store.list_author_decisions(decision_key="alpha-term") == [revised]
    assert store.list_author_decisions(decision_key="alpha-term", latest_only=False) == [
        alpha,
        revised,
    ]


@pytest.mark.parametrize("decision_key", ["Preferred-Term", "preferred_term", "", "term v2", " "])
def test_a_decision_key_must_be_a_stable_kebab_case_identifier(
    decision_key: str, store: ProjectStore, database_path: Path
) -> None:
    before = _rows(database_path)

    with pytest.raises(ProjectStoreError):
        store.save_author_decision(_decision(decision_key=decision_key))

    assert _rows(database_path) == before


def test_an_undeclared_kind_is_refused(store: ProjectStore, database_path: Path) -> None:
    before = _rows(database_path)

    with pytest.raises(ProjectStoreError, match="Unsupported author decision kind"):
        store.save_author_decision(_decision(kind="style_rule"))

    assert _rows(database_path) == before


def test_the_declared_kinds_and_scopes_are_the_ones_the_module_enforces() -> None:
    """Every declared kind and every open scope must build a request the store will accept."""
    assert set(DECISION_KINDS) == {EXPRESSION_PREFERENCE, RESEARCH_BOUNDARY}
    assert set(DECISION_SCOPES) == {"DOCUMENT", "PROJECT", "LOCAL", "SECTION", "PROFILE"}
    assert set(OPEN_SCOPES) == {"DOCUMENT", "PROJECT"}

    for request in (
        _decision(kind=EXPRESSION_PREFERENCE),
        _decision(kind=RESEARCH_BOUNDARY),
        _decision(scope="DOCUMENT"),
        _decision(scope="PROJECT"),
    ):
        assert request.kind in DECISION_KINDS
        assert request.scope in OPEN_SCOPES


@pytest.mark.parametrize("scope", ["LOCAL", "SECTION", "PROFILE"])
def test_a_scope_that_opens_later_is_refused_rather_than_stored_thin(
    scope: str, store: ProjectStore, database_path: Path
) -> None:
    """Each later scope needs a binding this stage cannot produce, so none is stored without it."""
    before = _rows(database_path)

    with pytest.raises(ProjectStoreError, match="opens in"):
        store.save_author_decision(_decision(scope=scope))

    assert _rows(database_path) == before


def test_an_undeclared_scope_is_refused(store: ProjectStore) -> None:
    with pytest.raises(ProjectStoreError, match="Unsupported author decision scope"):
        store.save_author_decision(_decision(scope="CHAPTER"))


@pytest.mark.parametrize("confirmed_source", ["agent-proposal", "an-agent", "model-summary"])
def test_an_agent_proposal_is_not_an_author_decision(
    confirmed_source: str, store: ProjectStore, database_path: Path
) -> None:
    before = _rows(database_path)

    with pytest.raises(ProjectStoreError):
        store.save_author_decision(_decision(confirmed_source=confirmed_source))

    assert _rows(database_path) == before


@pytest.mark.parametrize("field", ["content", "applies_to", "reason", "invalidation"])
def test_required_text_must_be_nonblank(
    field: str, store: ProjectStore, database_path: Path
) -> None:
    before = _rows(database_path)

    with pytest.raises(ProjectStoreError, match=field):
        store.save_author_decision(_decision(**{field: "   "}))

    assert _rows(database_path) == before


def test_a_decision_binds_a_retained_baseline_and_refuses_an_unknown_one(
    store: ProjectStore, database_path: Path
) -> None:
    baseline_id = _apply_source(store)

    bound = store.save_author_decision(_decision(baseline_id=baseline_id))

    assert bound["baseline_id"] == baseline_id
    assert store.get_author_decision(bound["decision_id"]) == bound
    before = _rows(database_path)
    with pytest.raises(ProjectStoreError):
        store.save_author_decision(_decision(decision_key="unbound-term", baseline_id="baseline-x"))
    assert _rows(database_path) == before


def test_a_stored_decision_cannot_disagree_with_its_sql_identity(
    store: ProjectStore, database_path: Path
) -> None:
    saved = store.save_author_decision(_decision())
    decision_id = cast(str, saved["decision_id"])
    with closing(sqlite3.connect(database_path)) as connection, connection:
        row = connection.execute(
            "SELECT payload FROM author_decision WHERE decision_id=?", (decision_id,)
        ).fetchone()
        record = decode_json_object(row[0])
        record["decision_key"] = "another-term"
        connection.execute(
            "UPDATE author_decision SET payload=? WHERE decision_id=?",
            (encode_json_object(record), decision_id),
        )
    before = _rows(database_path)

    with pytest.raises(ProjectStoreError, match="decision_key differs"):
        store.get_author_decision(decision_id)
    with pytest.raises(ProjectStoreError, match="decision_key differs"):
        store.list_author_decisions()

    assert _rows(database_path) == before


def test_an_unknown_decision_id_is_refused_rather_than_returned_empty(store: ProjectStore) -> None:
    assert store.list_author_decisions() == []

    with pytest.raises(ProjectStoreError, match="Author decision does not exist"):
        store.get_author_decision("preferred-term-mvcc-v1")


def test_a_saved_decision_survives_a_reopen_with_its_original_bytes(
    store: ProjectStore, database_path: Path
) -> None:
    saved: JsonObject = store.save_author_decision(_decision(baseline_id=None))

    assert ProjectStore(database_path).get_author_decision(cast(str, saved["decision_id"])) == saved
