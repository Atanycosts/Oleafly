import hashlib
import json
from dataclasses import FrozenInstanceError, replace

import pytest

from research_file_workbench.projects.models import BaselineRequest, ProjectStoreError


def _request() -> BaselineRequest:
    return BaselineRequest(
        project_id="project-digest-tests",
        actor_id="operator-digest-tests",
        request_id="request-first-delivery",
        expected_baseline_id=None,
        source_sha256="a" * 64,
    )


def test_request_digest_matches_existing_canonical_contract() -> None:
    request = _request()
    payload = {
        "project_id": request.project_id,
        "actor_id": request.actor_id,
        "expected_baseline_id": None,
        "artifact_version_ids": ["artifact-version-" + "a" * 64],
        "author_decision_version_ids": [],
        "rule_bindings": [],
    }
    envelope = {
        "canonicalization": "rfw-json-v1",
        "kind": "read_baseline_request_digest",
        "payload": payload,
    }
    encoded = json.dumps(
        envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")

    assert request.request_digest == hashlib.sha256(encoded).hexdigest()
    assert request.artifact_version_id == "artifact-version-" + "a" * 64


def test_transport_request_id_does_not_change_business_digest() -> None:
    request = _request()

    assert (
        replace(request, request_id="request-new-delivery").request_digest == request.request_digest
    )


@pytest.mark.parametrize(
    "changes",
    [
        {"project_id": "project-other"},
        {"actor_id": "operator-other"},
        {"expected_baseline_id": "baseline-earlier"},
        {"source_sha256": "b" * 64},
    ],
)
def test_request_digest_changes_when_submission_meaning_changes(changes: dict[str, str]) -> None:
    request = _request()

    assert replace(request, **changes).request_digest != request.request_digest


def test_request_values_are_immutable() -> None:
    request = _request()

    with pytest.raises(FrozenInstanceError):
        request.source_sha256 = "b" * 64


@pytest.mark.parametrize("source_sha256", ["", "a" * 63, "A" * 64, "g" * 64, " a" + "b" * 62])
def test_request_rejects_invalid_source_hash(source_sha256: str) -> None:
    with pytest.raises(ProjectStoreError):
        replace(_request(), source_sha256=source_sha256)


def test_request_requires_project_identity_even_when_expected_baseline_is_optional() -> None:
    with pytest.raises(ProjectStoreError):
        replace(_request(), project_id=None)
