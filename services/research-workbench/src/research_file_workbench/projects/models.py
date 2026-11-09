"""Validated requests for local reading-baseline management."""

import re
from dataclasses import dataclass

from research_file_workbench.common.digests import digest_payload
from research_file_workbench.common.json_io import JsonObject


class ProjectStoreError(ValueError):
    """Raised when persistent project data cannot satisfy its declared contract."""


class BaselineConflictError(ProjectStoreError):
    """Raised when a read attempts to commit against a displaced current baseline."""


def require_record_text(value: object, label: str) -> str:
    """Validate a required textual field at a persistent project-record boundary."""
    if not isinstance(value, str) or not value.strip():
        raise ProjectStoreError(f"{label} must be a nonblank string")
    return value


@dataclass(frozen=True, slots=True)
class BaselineRequest:
    """One confirmed source binding with stable idempotency and concurrency inputs."""

    project_id: str
    actor_id: str
    request_id: str
    expected_baseline_id: str | None
    source_sha256: str

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

    @property
    def artifact_version_id(self) -> str:
        """Return the immutable source identity shared with DOCX receipts."""
        return f"artifact-version-{self.source_sha256}"

    def payload(self) -> JsonObject:
        """Return exactly the six semantic fields of the frozen digest contract."""
        return {
            "project_id": self.project_id,
            "actor_id": self.actor_id,
            "expected_baseline_id": self.expected_baseline_id,
            "artifact_version_ids": [self.artifact_version_id],
            "author_decision_version_ids": [],
            "rule_bindings": [],
        }

    @property
    def request_digest(self) -> str:
        """Compute the existing rfw-json-v1 read-baseline digest."""
        return digest_payload("read_baseline_request_digest", self.payload())
