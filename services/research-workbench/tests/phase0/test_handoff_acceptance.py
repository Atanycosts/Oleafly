import copy
from pathlib import Path

import pytest

from research_file_workbench.common.json_io import load_json_object
from research_file_workbench.phase0.contract_checks import validate_contract_content
from research_file_workbench.phase0.handoff_acceptance import CASE_IDS
from research_file_workbench.phase0.models import ContractValueError

CONTRACT = Path(__file__).resolve().parents[2] / "contracts/phase0/s1-handoff-acceptance.json"


def test_handoff_fixtures_define_expectations_without_claiming_implementation() -> None:
    document = load_json_object(CONTRACT)
    validate_contract_content(CONTRACT.name, document)
    assert document["validation_scope"] == "acceptance_specification_only"
    assert document["implementation_status"] == "planned"


@pytest.mark.parametrize("section", CASE_IDS)
def test_every_handoff_scenario_is_required(section: str) -> None:
    original = load_json_object(CONTRACT)
    for case in original[section]["cases"]:
        document = copy.deepcopy(original)
        document[section]["cases"] = [
            item for item in document[section]["cases"] if item["fixture_id"] != case["fixture_id"]
        ]
        with pytest.raises(ContractValueError, match="Missing or unknown"):
            validate_contract_content(CONTRACT.name, document)


@pytest.mark.parametrize(
    ("section", "case_index", "field", "replacement"),
    [
        ("material_directory", 0, "actual_read_ids", ["body-target"]),
        ("material_directory", 1, "unread_ids", []),
        ("material_directory", 1, "entry_ids", ["restricted-note"]),
        ("material_directory", 2, "missing_ids", []),
        ("reading_bookmarks", 1, "expected_verdict", "accepted"),
        ("reading_bookmarks", 2, "validity", "CURRENT"),
        ("reading_bookmarks", 2, "bookmark_baseline_id", "baseline-b"),
        ("reading_bookmarks", 3, "retained_ids", []),
        ("reading_bookmarks", 3, "bookmark_exists", 0),
        ("author_decisions", 0, "visible_decision_ids", ["unconfirmed-suggestion"]),
        ("author_decisions", 1, "creates_author_decision", True),
        ("author_decisions", 2, "expected_verdict", "accepted"),
        ("author_decisions", 3, "creates_semantic_pass", True),
        ("cache_validity", 0, "expected_verdict", "miss"),
        ("cache_validity", 1, "expected_impacted_ids", []),
        ("cache_validity", 2, "expected_preserved_ids", ["structure-index"]),
        ("cache_validity", 7, "creates_semantic_pass", True),
        ("cache_validity", 7, "creates_read_receipt", True),
        ("cache_validity", 8, "expected_verdict", "hit"),
        ("cache_validity", 9, "expected_impacted_ids", ["structure-index"]),
    ],
)
def test_contradictory_handoff_expectations_are_rejected(
    section, case_index, field, replacement
) -> None:
    document = load_json_object(CONTRACT)
    document[section]["cases"][case_index]["expected"][field] = replacement
    with pytest.raises(ContractValueError, match="Contradictory acceptance expectation"):
        validate_contract_content(CONTRACT.name, document)


@pytest.mark.parametrize("mode", ["implemented", "duplicate", "snake-id", "camel-key", "empty"])
def test_handoff_contract_identity_and_status_are_strict(mode: str) -> None:
    document = load_json_object(CONTRACT)
    if mode == "implemented":
        document["implementation_status"] = "implemented"
    elif mode == "duplicate":
        document["material_directory"]["cases"].append(
            copy.deepcopy(document["material_directory"]["cases"][0])
        )
    elif mode == "snake-id":
        document["reading_bookmarks"]["task_id"] = "task_a"
    elif mode == "camel-key":
        document["implementationStatus"] = document.pop("implementation_status")
    else:
        document["cache_validity"]["entries"] = []
    with pytest.raises(ContractValueError):
        validate_contract_content(CONTRACT.name, document)


@pytest.mark.parametrize(
    "mode", ["removed-dependency", "missing-fallback", "unknown-change", "erased-scenario"]
)
def test_cache_fixture_inputs_cannot_weaken_the_required_scenarios(mode: str) -> None:
    document = load_json_object(CONTRACT)
    section = document["cache_validity"]
    if mode == "removed-dependency":
        section["entries"][1]["dependency_keys"].remove("parser_version")
    elif mode == "missing-fallback":
        section["cases"][9]["input"]["fallback_scope"] = []
    elif mode == "unknown-change":
        section["cases"][0]["input"]["changed_dependencies"] = ["unknown_dependency"]
    else:
        section["cases"][2]["input"] = copy.deepcopy(section["cases"][0]["input"])
        section["cases"][2]["expected"] = copy.deepcopy(section["cases"][0]["expected"])
    with pytest.raises(ContractValueError):
        validate_contract_content(CONTRACT.name, document)
