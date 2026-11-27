"""Validated requests for local reading-baseline management."""

import re
from dataclasses import dataclass

from research_file_workbench.common.digests import digest_payload
from research_file_workbench.common.json_io import JsonObject


class ProjectStoreError(ValueError):
    """Raised when persistent project data cannot satisfy its declared contract."""


PROJECT_ROLES = frozenset({"manuscript", "format_candidate"})


class BaselineConflictError(ProjectStoreError):
    """Raised when a read attempts to commit against a displaced current baseline."""

    def __init__(self, message: str, *, result: JsonObject | None = None) -> None:
        super().__init__(message)
        self.result = result


def require_record_text(value: object, label: str) -> str:
    """Validate a required textual field at a persistent project-record boundary."""
    if not isinstance(value, str) or not value.strip():
        raise ProjectStoreError(f"{label} must be a nonblank string")
    return value


def require_project_role(value: object) -> str:
    """Validate the project's ordinary-manuscript or retained-candidate role."""
    if not isinstance(value, str) or value not in PROJECT_ROLES:
        raise ProjectStoreError("Project role must be manuscript or format_candidate")
    return value


@dataclass(frozen=True, slots=True)
class BaselineRequest:
    """One confirmed source binding with stable idempotency and concurrency inputs."""

    project_id: str
    actor_id: str
    request_id: str
    expected_baseline_id: str | None
    source_sha256: str
    original_sha256: str | None = None

    def __post_init__(self) -> None:
        if self.project_id is None:
            raise ProjectStoreError("project_id must be a lowercase kebab-case identifier")
        for name, value in (
            ("project_id", self.project_id),
            ("expected_baseline_id", self.expected_baseline_id),
        ):
            if value is not None and (
                not isinstance(value, str)
                or re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", value) is None
            ):
                raise ProjectStoreError(f"{name} must be a lowercase kebab-case identifier")
        for name, value in (("actor_id", self.actor_id), ("request_id", self.request_id)):
            if not isinstance(value, str) or not value.strip():
                raise ProjectStoreError(f"{name} must be a nonblank string")
        if re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", self.request_id) is None:
            raise ProjectStoreError("request_id must be a lowercase kebab-case identifier")
        if (
            not isinstance(self.source_sha256, str)
            or re.fullmatch(r"[0-9a-f]{64}", self.source_sha256) is None
        ):
            raise ProjectStoreError(
                "source_sha256 must contain 64 lowercase hexadecimal characters"
            )
        if self.original_sha256 is not None and (
            not isinstance(self.original_sha256, str)
            or re.fullmatch(r"[0-9a-f]{64}", self.original_sha256) is None
        ):
            raise ProjectStoreError(
                "original_sha256 must contain 64 lowercase hexadecimal characters"
            )
        if self.original_sha256 is not None and self.original_sha256 == self.source_sha256:
            raise ProjectStoreError("original_sha256 must identify the changed source")

    @property
    def artifact_version_id(self) -> str:
        """Return the immutable source identity shared with DOCX receipts."""
        return f"artifact-version-{self.source_sha256}"

    def payload(self) -> JsonObject:
        """Return the frozen fields, binding a changed source's original as a second artifact."""
        artifact_version_ids = [self.artifact_version_id]
        if self.original_sha256 is not None:
            artifact_version_ids.append(f"artifact-version-{self.original_sha256}")
        payload: JsonObject = {
            "project_id": self.project_id,
            "actor_id": self.actor_id,
            "expected_baseline_id": self.expected_baseline_id,
            "artifact_version_ids": artifact_version_ids,
            "author_decision_version_ids": [],
            "rule_bindings": [],
        }
        return payload

    @property
    def request_digest(self) -> str:
        """Compute the existing rfw-json-v1 read-baseline digest."""
        return digest_payload("read_baseline_request_digest", self.payload())
