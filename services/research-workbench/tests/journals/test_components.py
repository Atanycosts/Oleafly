"""Shared components remain strict declarative candidates with explicit applicability."""

from copy import deepcopy

import pytest

from research_file_workbench.common.json_io import encode_json_object
from research_file_workbench.journals.analysis import analyze_world
from research_file_workbench.journals.models import SourceInput, WorldAnalysisError


def component():
    return {
        "schema_version": "journal-rule-component-1.0.0",
        "component_id": "page-geometry",
        "component_version": "1.0.0",
        "applicability": {
            "journal_ids": ["journal-test"],
            "article_types": ["research_article"],
            "stages": ["initial_submission"],
            "languages": ["en"],
            "basis": "Operator-provided applicability note",
        },
        "sources": [
            {
                "source_id": "guide-reference",
                "title": "Captured guide excerpt",
                "locator": "page 1",
                "quote": "All manuscript pages must use 2 columns.",
            }
        ],
        "rules": [
            {
                "property": "columns",
                "expected": 2,
                "unit": "count",
                "source_refs": ["guide-reference"],
            }
        ],
    }


def analyzed(document):
    return analyze_world(
        "journal-test",
        "Test",
        [
            SourceInput(
                "component.json", "rule_component_json", encode_json_object(document).encode()
            )
        ],
    )


def test_component_is_candidate_with_captured_provenance():
    world = analyzed(component())
    rule = world["rules"][0]
    assert rule["basis_status"] == "candidate"
    assert rule["expected"] == 2
    assert all(item["source_id"] == world["sources"][0]["source_id"] for item in rule["evidence"])
    assert any(
        item["quote"] == "All manuscript pages must use 2 columns." for item in rule["evidence"]
    )


def test_exact_font_component_remains_a_candidate():
    document = component()
    document["rules"] = [
        {
            "property": "body_font_family",
            "expected": "SimSun",
            "unit": "font_family",
            "source_refs": ["guide-reference"],
        }
    ]
    document["sources"][0]["quote"] = "Body text must use SimSun font."
    rule = analyzed(document)["rules"][0]
    assert rule["expected"] == "SimSun"
    assert rule["basis_status"] == "candidate"
    assert rule["evidence"][1]["quote"] == document["sources"][0]["quote"]


@pytest.mark.parametrize("value", [400, "", " SimSun ", "SimSun\n"])
def test_font_component_rejects_invalid_family_values(value):
    document = component()
    document["rules"][0].update(property="body_font_family", expected=value, unit="font_family")
    with pytest.raises(WorldAnalysisError):
        analyzed(document)


@pytest.mark.parametrize(
    "change",
    [
        "script",
        "claim_confirmed",
        "unknown_property",
        "missing_reference",
        "wrong_unit",
        "unknown_version",
    ],
)
def test_components_cannot_execute_or_self_confirm(change):
    document = component()
    if change == "script":
        document["script"] = "open('author.docx','wb')"
    elif change == "claim_confirmed":
        document["rules"][0]["basis_status"] = "confirmed"
    elif change == "unknown_property":
        document["rules"][0]["property"] = "python_expression"
    elif change == "missing_reference":
        document["rules"][0]["source_refs"] = ["not-present"]
    elif change == "wrong_unit":
        document["rules"][0]["unit"] = "millimeters"
    else:
        document["schema_version"] = "future"
    with pytest.raises(WorldAnalysisError):
        analyzed(document)


def test_inapplicable_component_is_retained_but_does_not_supply_rules():
    document = component()
    document["applicability"]["journal_ids"] = ["another-journal"]
    world = analyzed(document)
    assert world["rules"] == []
    assert any(item["code"] == "component_scope_mismatch" for item in world["coverage_gaps"])


def test_component_version_participates_in_world_identity():
    first = component()
    second = deepcopy(first)
    second["component_version"] = "1.0.1"
    assert analyzed(first)["version_id"] != analyzed(second)["version_id"]
