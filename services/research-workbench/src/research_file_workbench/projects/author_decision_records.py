"""Persist scoped author decisions as immutable versioned records.

Section 3.3.1 keeps a stated preference apart from a claim about the research itself: the first may
reduce a confirmed style reminder, while the second holds the author's judgement and the related
evidence state apart and never turns a confirmation into a scientific fact. Only a trusted user
confirmation creates a decision here; an agent may propose one elsewhere, but a proposal is not a
record, and no entry point publishes a preference or overrides an evidence state on its own.

An update never rewrites a decision. It appends a new version that points at the one it replaces, so
an earlier confirmation keeps its original content and stays readable.
"""

import re
import sqlite3
from dataclasses import dataclass
from typing import cast

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.projects.baseline_records import get_baseline
from research_file_workbench.projects.models import ProjectStoreError, require_record_text
from research_file_workbench.projects.project_database import project_info

# The two declared kinds. `expression_preference` covers wording and style exceptions; the
# research-boundary kind records a judgement about goals or facts that must stay distinguishable
# from evidence and can never be promoted to a passed claim.
EXPRESSION_PREFERENCE = "expression_preference"
RESEARCH_BOUNDARY = "research_boundary"
DECISION_KINDS = (EXPRESSION_PREFERENCE, RESEARCH_BOUNDARY)

# Section 3.3.1 declares five scopes and names the stage each one opens in. A later scope is refused
# here rather than stored thin: each needs a binding this stage cannot produce yet -- a located
# sentence with its artifact version and locator evidence, a resolved section, or a separately
# chosen application range -- and a record without that binding would claim more than it holds.
_SCOPE_STAGE = {
    "DOCUMENT": "S1",
    "PROJECT": "S1",
    "LOCAL": "S2B",
    "SECTION": "S2B",
    "PROFILE": "later",
}
DECISION_SCOPES = tuple(_SCOPE_STAGE)
OPEN_SCOPES = tuple(scope for scope, stage in _SCOPE_STAGE.items() if stage == "S1")

# Only a trusted user confirmation creates a decision. The local operator is the one trusted origin
# this stage has; an agent proposal is refused instead of being recorded as an author decision.
_TRUSTED_SOURCES = ("local_operator",)

_DECISION_SELECT = (
    "SELECT decision_id,decision_key,project_id,baseline_id,supersedes,payload FROM author_decision"
)
# Stable identifiers are kebab-case, which also keeps the derived versioned id safe to embed.
_DECISION_KEY = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")


def _require_decision_key(value: object) -> str:
    key = require_record_text(value, "decision_key")
    if _DECISION_KEY.fullmatch(key) is None:
        raise ProjectStoreError("decision_key must be kebab-case")
    return key


def _require_kind(value: object) -> str:
    kind = require_record_text(value, "kind")
    if kind not in DECISION_KINDS:
        raise ProjectStoreError(f"Unsupported author decision kind: {kind}")
    return kind


def _require_scope(value: object) -> str:
    scope = require_record_text(value, "scope")
    if scope not in _SCOPE_STAGE:
        raise ProjectStoreError(
            f"Unsupported author decision scope: {scope}; declared scopes are "
            f"{', '.join(DECISION_SCOPES)}"
        )
    if scope not in OPEN_SCOPES:
        raise ProjectStoreError(
            f"Author decision scope {scope} opens in {_SCOPE_STAGE[scope]}; this stage records "
            f"{', '.join(OPEN_SCOPES)}"
        )
    return scope


def _require_confirmation(value: object) -> str:
    """A decision exists only on a trusted confirmation recorded against it."""
    source = require_record_text(value, "confirmed_source")
    if source == "agent-proposal":
        raise ProjectStoreError("An agent proposal is not an author decision")
    if source not in _TRUSTED_SOURCES:
        raise ProjectStoreError(
            f"confirmed_source must be a trusted user origin ({', '.join(_TRUSTED_SOURCES)}), "
            f"not {source}"
        )
    return source


@dataclass(frozen=True, slots=True)
class AuthorDecisionRequest:
    """One confirmed author decision, validated before it reaches the database."""

    decision_key: str
    kind: str
    content: str
    scope: str
    applies_to: str
    confirmed_source: str
    reason: str
    invalidation: str
    baseline_id: str | None = None
    confirmed_at: str | None = None
    conditions: str | None = None
    rule_refs: tuple[str, ...] = ()
    evidence_refs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_decision_key(self.decision_key)
        _require_kind(self.kind)
        _require_scope(self.scope)
        _require_confirmation(self.confirmed_source)
        for name, value in (
            ("content", self.content),
            ("applies_to", self.applies_to),
            ("reason", self.reason),
            ("invalidation", self.invalidation),
        ):
            require_record_text(value, name)


def _verified_decision(row: sqlite3.Row, project_id: str) -> JsonObject:
    """Bind a stored payload to the SQL identity and scope columns it was written with."""
    record = decode_json_object(row["payload"])
    for field in ("decision_id", "decision_key", "baseline_id", "supersedes"):
        if record.get(field) != row[field]:
            raise ProjectStoreError(f"Stored author decision {field} differs from its record")
    if row["project_id"] != project_id:
        raise ProjectStoreError("Stored author decision belongs to another project")
    return record


def save_author_decision(
    connection: sqlite3.Connection, request: AuthorDecisionRequest
) -> JsonObject:
    """Append one author-decision version, superseding any earlier version of the same key."""
    if request.baseline_id is not None:
        get_baseline(connection, request.baseline_id)
    project_id = cast(str, project_info(connection)["project_id"])
    previous = connection.execute(
        _DECISION_SELECT + " WHERE project_id=? AND decision_key=? ORDER BY rowid DESC LIMIT 1",
        (project_id, request.decision_key),
    ).fetchone()
    supersedes: str | None = None
    version = 1
    if previous is not None:
        prior = _verified_decision(previous, project_id)
        stored_version = prior.get("version")
        if not isinstance(stored_version, int) or stored_version < 1:
            raise ProjectStoreError("Stored author decision version is not a positive integer")
        supersedes = cast(str, prior["decision_id"])
        version = stored_version + 1
    recorded_at = utc_now_iso()
    decision_id = f"{request.decision_key}-v{version}"
    payload: JsonObject = {
        "decision_id": decision_id,
        "decision_key": request.decision_key,
        "version": version,
        "kind": request.kind,
        "content": request.content,
        "scope": request.scope,
        "applies_to": request.applies_to,
        "conditions": request.conditions,
        "confirmed_source": request.confirmed_source,
        "confirmed_at": request.confirmed_at or recorded_at,
        "reason": request.reason,
        "rule_refs": list(request.rule_refs),
        "evidence_refs": list(request.evidence_refs),
        "invalidation": request.invalidation,
        "baseline_id": request.baseline_id,
        "supersedes": supersedes,
        "recorded_at": recorded_at,
    }
    connection.execute(
        "INSERT INTO author_decision VALUES (?,?,?,?,?,?)",
        (
            decision_id,
            request.decision_key,
            project_id,
            request.baseline_id,
            supersedes,
            encode_json_object(payload),
        ),
    )
    return payload


def get_author_decision(connection: sqlite3.Connection, decision_id: str) -> JsonObject:
    """Return one decision version exactly as it was recorded."""
    row = connection.execute(
        _DECISION_SELECT + " WHERE decision_id=?",
        (require_record_text(decision_id, "decision_id"),),
    ).fetchone()
    if row is None:
        raise ProjectStoreError("Author decision does not exist")
    return _verified_decision(row, cast(str, project_info(connection)["project_id"]))


def list_author_decisions(
    connection: sqlite3.Connection,
    *,
    decision_key: str | None = None,
    latest_only: bool = True,
) -> list[JsonObject]:
    """Return decisions in commit order; by default only the current version of each key."""
    query = _DECISION_SELECT
    parameters: tuple[str, ...] = ()
    if decision_key is not None:
        query += " WHERE decision_key=?"
        parameters = (_require_decision_key(decision_key),)
    project_id = cast(str, project_info(connection)["project_id"])
    records = [
        _verified_decision(row, project_id)
        for row in connection.execute(query + " ORDER BY rowid", parameters)
    ]
    if not latest_only:
        return records
    # Keep the last record of each key, which is its current version, in the order those versions
    # were committed rather than the order each key first appeared.
    current = {cast(str, record["decision_key"]): index for index, record in enumerate(records)}
    return [
        record
        for index, record in enumerate(records)
        if current[cast(str, record["decision_key"])] == index
    ]
