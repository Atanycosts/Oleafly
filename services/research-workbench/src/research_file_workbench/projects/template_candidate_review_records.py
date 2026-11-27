"""One pending reviewed DOCX format candidate per target project."""

from __future__ import annotations

import sqlite3

from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.projects.models import ProjectStoreError


class CandidateReviewConflictError(ProjectStoreError):
    """Raised when a review write or clear uses a stale candidate check identity."""


def get_review(connection: sqlite3.Connection) -> JsonObject | None:
    """Return the project's pending reviewed candidate, if one was saved."""
    row = connection.execute(
        "SELECT record_json FROM template_candidate_review WHERE project_id="
        "(SELECT project_id FROM project)"
    ).fetchone()
    return None if row is None else decode_json_object(row["record_json"])


def save_review(
    connection: sqlite3.Connection,
    review: JsonObject,
    expected_candidate_check_id: str | None,
) -> JsonObject:
    """Replace the pending review only from the candidate check the caller observed."""
    stored = get_review(connection)
    stored_check_id = _candidate_check_id(stored)
    if stored_check_id != expected_candidate_check_id:
        raise CandidateReviewConflictError(
            "The pending format candidate changed; refresh it before saving."
        )
    project_id = connection.execute("SELECT project_id FROM project").fetchone()[0]
    connection.execute(
        "INSERT INTO template_candidate_review(project_id,record_json) VALUES (?,?) "
        "ON CONFLICT(project_id) DO UPDATE SET record_json=excluded.record_json",
        (project_id, encode_json_object(review)),
    )
    return review


def require_review_for_check(connection: sqlite3.Connection, candidate_check_id: str) -> JsonObject:
    """Require adoption to consume the exact pending reviewed candidate."""
    stored = get_review(connection)
    if stored is None or _candidate_check_id(stored) != candidate_check_id:
        raise CandidateReviewConflictError(
            "The pending format candidate changed; refresh it before adopting."
        )
    return stored


def clear_review_for_check(connection: sqlite3.Connection, candidate_check_id: str) -> None:
    """Clear only the pending review consumed by a successful adoption."""
    connection.execute(
        "DELETE FROM template_candidate_review WHERE "
        "json_extract(record_json,'$.candidate_check_id')=?",
        (candidate_check_id,),
    )


def _candidate_check_id(review: JsonObject | None) -> str | None:
    if review is None:
        return None
    candidate_check_id = review.get("candidate_check_id")
    if not isinstance(candidate_check_id, str):
        raise ProjectStoreError("Stored format candidate review has no check identity")
    return candidate_check_id
