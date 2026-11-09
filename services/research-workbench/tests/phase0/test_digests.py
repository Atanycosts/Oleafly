import copy
from pathlib import Path

import pytest

from research_file_workbench.common.digests import DigestError, canonical_json, digest_payload
from research_file_workbench.common.json_io import load_json_object
from research_file_workbench.phase0.digests import validate_digest_contract

CONTRACT = Path(__file__).resolve().parents[2] / "contracts/phase0/digest-contract.json"


def test_fixed_digest_vectors() -> None:
    validate_digest_contract(load_json_object(CONTRACT))


def test_key_order_is_irrelevant_but_array_order_and_null_are_not() -> None:
    assert canonical_json({"b": 1, "a": 2}) == canonical_json({"a": 2, "b": 1})
    assert canonical_json(["a", "b"]) != canonical_json(["b", "a"])
    assert canonical_json({}) != canonical_json({"a": None})


@pytest.mark.parametrize("value", [1.5, float("nan"), 2**53, {1: "wrong"}])
def test_ambiguous_digest_inputs_are_rejected(value: object) -> None:
    with pytest.raises(DigestError):
        canonical_json(value)


def test_reordered_plan_changes_hash_and_retry_metadata_is_rejected() -> None:
    contract = load_json_object(CONTRACT)
    plan = next(vector for vector in contract["vectors"] if vector["vector_id"] == "plan")
    payload = copy.deepcopy(plan["input"]["payload"])
    before = digest_payload("plan_hash", payload)
    payload["ordered_proposal_hashes"].reverse()
    assert digest_payload("plan_hash", payload) != before
    payload["execution_attempt"] = 2
    with pytest.raises(DigestError):
        digest_payload("plan_hash", payload)
