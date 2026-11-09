"""Canonical request digests shared by validation and runtime operations."""

import hashlib
import json

from research_file_workbench.common.json_io import JsonObject


class DigestError(ValueError):
    """Raised for values outside the published digest contract."""


CANONICALIZATION_ID = "rfw-json-v1"
MAX_EXACT_INTEGER = 2**53 - 1
DIGEST_FIELDS = {
    "proposal_hash": {"source_baseline", "content", "dependencies", "impact_scope"},
    "plan_hash": {
        "source_baseline",
        "ordered_proposal_hashes",
        "merge_strategy",
        "combined_impact",
        "validation_requirements",
        "review_policy_version",
    },
    "request_digest": {
        "project_id",
        "access_scope",
        "operation_type",
        "contract_version",
        "source_baseline",
        "plan_hash",
        "approval_id",
        "parameters",
    },
    "read_baseline_request_digest": {
        "project_id",
        "actor_id",
        "expected_baseline_id",
        "artifact_version_ids",
        "author_decision_version_ids",
        "rule_bindings",
    },
}


def canonical_json(value: object) -> str:
    """Encode the restricted contract JSON domain; reject floats and invalid Unicode."""

    def check(item: object) -> None:
        if item is None or isinstance(item, bool):
            return
        if isinstance(item, str):
            item.encode("utf-8", errors="strict")
        elif isinstance(item, int) and abs(item) <= MAX_EXACT_INTEGER:
            return
        elif isinstance(item, list):
            for child in item:
                check(child)
        elif isinstance(item, dict) and all(isinstance(key, str) for key in item):
            for key, child in item.items():
                check(key)
                check(child)
        else:
            raise DigestError("Digest input requires exact JSON values; encode decimals as strings")

    check(value)
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )


def digest_payload(kind: str, payload: JsonObject) -> str:
    """Hash an explicitly scoped payload; metadata must be removed by the caller's boundary."""
    if kind not in DIGEST_FIELDS or set(payload) != DIGEST_FIELDS[kind]:
        raise DigestError(f"Unexpected digest fields for {kind}")
    envelope = {"canonicalization": CANONICALIZATION_ID, "kind": kind, "payload": payload}
    return hashlib.sha256(canonical_json(envelope).encode("utf-8")).hexdigest()
