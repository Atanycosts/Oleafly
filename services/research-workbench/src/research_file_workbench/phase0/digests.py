"""Phase 0 canonicalization fixtures; this module does not execute or approve plans."""

import hashlib

from research_file_workbench.common.digests import (
    CANONICALIZATION_ID,
    DIGEST_FIELDS,
    DigestError,
    canonical_json,
    digest_payload,
)
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.phase0.contract_checks import (
    hash_value,
    keyed_records,
    object_array,
    object_value,
    string_array,
    string_value,
)
from research_file_workbench.phase0.models import ContractValueError


def validate_digest_contract(document: JsonObject) -> None:
    """Check digest fixtures using the shared runtime canonicalization."""
    try:
        _validate_digest_contract(document)
    except DigestError as exc:
        raise ContractValueError(str(exc)) from exc


def _validate_digest_contract(document: JsonObject) -> None:
    """Check the published field boundaries and fixed independent canonicalization vectors."""
    if document.get("canonicalization_id") != CANONICALIZATION_ID:
        raise ContractValueError("Unsupported digest canonicalization")
    string_array(document, "normalization_rules")
    kinds = object_value(document, "kinds")
    if set(kinds) != set(DIGEST_FIELDS):
        raise ContractValueError("Missing digest kind")
    for kind, required in DIGEST_FIELDS.items():
        if set(string_array(object_value(kinds, kind), "fields")) != required:
            raise ContractValueError(f"Digest field boundary mismatch: {kind}")
    vectors = keyed_records(object_array(document, "vectors"), "vector_id")
    if set(vectors) != {
        "null-and-empty",
        "unicode-and-order",
        "proposal",
        "plan",
        "request",
        "read-baseline",
    }:
        raise ContractValueError("Missing required digest vectors")
    for identity, vector in vectors.items():
        encoded = canonical_json(vector.get("input"))
        if encoded != string_value(vector, "canonical_json"):
            raise ContractValueError(f"Canonicalization vector mismatch: {identity}")
        if hashlib.sha256(encoded.encode("utf-8")).hexdigest() != hash_value(vector, "sha256"):
            raise ContractValueError(f"Digest vector mismatch: {identity}")
        if identity in {"proposal", "plan", "request", "read-baseline"}:
            envelope = object_value(vector, "input")
            payload = object_value(envelope, "payload")
            if digest_payload(string_value(envelope, "kind"), payload) != vector["sha256"]:
                raise ContractValueError(f"Digest envelope mismatch: {identity}")
