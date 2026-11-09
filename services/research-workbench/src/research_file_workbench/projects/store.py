"""Public project persistence operations with one SQLite transaction boundary per write."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.projects import (
    artifact_records,
    author_decision_records,
    baseline_records,
    evidence_records,
    read_records,
)
from research_file_workbench.projects.models import (
    BaselineConflictError,
    BaselineRequest,
)
from research_file_workbench.projects.project_database import (
    connect_project,
    create_database,
    inspect_identity,
    project_info,
)


class ProjectStore:
    """Own connection and transaction lifetimes for one persistent local project."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path

    @classmethod
    def create(
        cls, database_path: Path, *, project_id: str, author_workspace_root: str
    ) -> ProjectStore:
        """Create a new project exclusively, leaving an existing database untouched."""
        create_database(
            database_path, project_id=project_id, author_workspace_root=author_workspace_root
        )
        return cls(database_path)

    def info(self) -> JsonObject:
        """Return the project's authoritative current-baseline pointer."""
        with connect_project(self.database_path) as connection:
            return project_info(connection)

    def inspect_identity(self) -> JsonObject:
        """Inspect project ownership without replaying a SQLite recovery journal."""
        return inspect_identity(self.database_path)

    def lookup_request(
        self, actor_id: str, request_id: str, request_digest: str
    ) -> JsonObject | None:
        """Replay the saved result or record an attempted conflicting reuse of its ID."""
        with connect_project(self.database_path) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            return baseline_records.lookup_request(connection, actor_id, request_id, request_digest)

    def apply_baseline(
        self,
        request: BaselineRequest,
        *,
        source_bytes: bytes | None,
        source_path: str,
        confirmation_reason: str,
        evidence: Sequence[JsonObject],
        reader_version: str,
    ) -> JsonObject:
        """Atomically bind an immutable input after replay and expected-baseline checks."""
        with connect_project(self.database_path) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            return baseline_records.apply_baseline(
                connection,
                request,
                source_bytes=source_bytes,
                source_path=source_path,
                confirmation_reason=confirmation_reason,
                evidence=evidence,
                reader_version=reader_version,
            )

    def record_rejection(
        self, request: BaselineRequest, *, source_path: str, confirmation_reason: str, reason: str
    ) -> JsonObject:
        """Persist a known input refusal; later retries cannot turn it into an applied request."""
        with connect_project(self.database_path) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            return baseline_records.record_rejection(
                connection,
                request,
                source_path=source_path,
                confirmation_reason=confirmation_reason,
                reason=reason,
            )

    def get_baseline(self, baseline_id: str | None = None) -> JsonObject:
        """Return one historical baseline, defaulting to the current pointer."""
        with connect_project(self.database_path) as connection:
            return baseline_records.get_selected_baseline(connection, baseline_id)

    def read_artifact(self, version_id: str) -> bytes:
        """Read retained bytes only after verifying their stored version hash."""
        with connect_project(self.database_path) as connection:
            return artifact_records.read_artifact(connection, version_id)

    @contextmanager
    def guard_baseline(self, expected_baseline_id: str) -> Iterator[JsonObject]:
        """Hold the project baseline stable while a dependent local record is committed."""
        with connect_project(self.database_path) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            baseline = baseline_records.get_selected_baseline(connection)
            if baseline["baseline_id"] != expected_baseline_id:
                raise BaselineConflictError("Current baseline changed before dependent submission")
            for version_id in cast(list[str], baseline["artifact_version_ids"]):
                artifact_records.read_artifact(connection, version_id)
            yield baseline

    def save_render_bundle(
        self,
        *,
        baseline_id: str,
        manifest: JsonObject,
        blobs: dict[str, bytes],
        actor_id: str,
        confirmation_reason: str,
    ) -> JsonObject:
        """Commit captured render artifacts and their immutable evidence registration together."""
        with connect_project(self.database_path) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            return evidence_records.save_render_bundle(
                connection,
                baseline_id=baseline_id,
                manifest=manifest,
                blobs=blobs,
                actor_id=actor_id,
                confirmation_reason=confirmation_reason,
            )

    def get_render_bundle(self, baseline_id: str, bundle_id: str) -> JsonObject:
        """Recover one exact registration; never choose the newest bundle implicitly."""
        with connect_project(self.database_path) as connection:
            return evidence_records.get_render_bundle(connection, baseline_id, bundle_id)

    def list_render_bundles(self, baseline_id: str | None = None) -> list[JsonObject]:
        """List registrations for the requested or current baseline without marking them read."""
        with connect_project(self.database_path) as connection:
            return evidence_records.list_render_bundles(connection, baseline_id)

    def list_baselines(self) -> list[JsonObject]:
        """Return immutable baseline history in insertion order."""
        with connect_project(self.database_path) as connection:
            return baseline_records.list_baselines(connection)

    def list_evidence(
        self, baseline_id: str | None = None, *, reader_version: str
    ) -> list[JsonObject]:
        """Derive present applicability without overwriting historical evidence or verdicts."""
        with connect_project(self.database_path) as connection:
            return evidence_records.list_evidence(
                connection, baseline_id, reader_version=reader_version
            )

    def save_read(
        self, *, baseline_id: str, require_current: bool, task: JsonObject, response: JsonObject
    ) -> None:
        """Save the exact response and task together, refusing a displaced required baseline."""
        with connect_project(self.database_path) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            read_records.save_read(
                connection,
                baseline_id=baseline_id,
                require_current=require_current,
                task=task,
                response=response,
            )

    def get_read(self, read_record_id: str) -> JsonObject:
        """Return the original persisted response without rebinding its historical receipt."""
        with connect_project(self.database_path) as connection:
            return read_records.get_read(connection, read_record_id)

    def list_reads(self, baseline_id: str | None = None) -> list[JsonObject]:
        """Return delivery summaries; omit baseline_id to list all historical deliveries."""
        with connect_project(self.database_path) as connection:
            return read_records.list_reads(connection, baseline_id)

    def save_author_decision(
        self, request: author_decision_records.AuthorDecisionRequest
    ) -> JsonObject:
        """Append one author-decision version inside its own transaction."""
        with connect_project(self.database_path) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            return author_decision_records.save_author_decision(connection, request)

    def get_author_decision(self, decision_id: str) -> JsonObject:
        """Return one decision version exactly as it was recorded."""
        with connect_project(self.database_path) as connection:
            return author_decision_records.get_author_decision(connection, decision_id)

    def list_author_decisions(
        self, *, decision_key: str | None = None, latest_only: bool = True
    ) -> list[JsonObject]:
        """Return decisions in commit order, by default the current version of each key."""
        with connect_project(self.database_path) as connection:
            return author_decision_records.list_author_decisions(
                connection, decision_key=decision_key, latest_only=latest_only
            )

    def get_request(self, actor_id: str, request_id: str) -> JsonObject:
        """Return the original request, local decision, result, and conflicting attempts."""
        with connect_project(self.database_path) as connection:
            return baseline_records.get_request(connection, actor_id, request_id)
