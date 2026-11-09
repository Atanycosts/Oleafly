"""Immutable operator decisions resolving existing journal geometry rules."""

from copy import deepcopy
from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.journals.models import (
    WorldAnalysisError,
    require_expected,
    validate_world_for_execution,
    world_manifest,
    world_version_id,
)


def revise_rule(
    world: JsonObject, rule_id: str, expected: int, reason: str, actor_id: str
) -> JsonObject:
    """Create a deterministic human-confirmed rule version, preserving source disagreement."""
    validate_world_for_execution(world)
    for name, value in (("rule_id", rule_id), ("reason", reason), ("actor_id", actor_id)):
        if not isinstance(value, str) or not value.strip():
            raise WorldAnalysisError(f"Rule decision {name} must be nonblank text")
    revised = deepcopy(world_manifest(world))
    rules = revised.get("rules")
    if not isinstance(rules, list):
        raise WorldAnalysisError("World rules must be structured records")
    matches = [rule for rule in rules if isinstance(rule, dict) and rule.get("rule_id") == rule_id]
    if len(matches) != 1:
        raise WorldAnalysisError("Rule decision must select one existing rule")
    rule = cast(JsonObject, matches[0])
    property_name = rule.get("property")
    if not isinstance(property_name, str):
        raise WorldAnalysisError("Rule property must be a supported geometry property")
    require_expected(property_name, expected)
    decision: JsonObject = {
        "base_version_id": world["version_id"],
        "rule_id": rule_id,
        "expected": expected,
        "reason": reason,
        "actor_id": actor_id,
    }
    decisions = revised.setdefault("manual_decisions", [])
    if not isinstance(decisions, list):
        raise WorldAnalysisError("World manual decisions must be a list")
    decisions.append(decision)
    rule["resolution"] = {
        **decision,
        "previous_basis_status": rule["basis_status"],
        "previous_expected": rule["expected"],
    }
    rule.update(expected=expected, basis_status="confirmed", confirmation_method="human_decision")
    limitations = rule.get("limitations")
    if not isinstance(limitations, list):
        raise WorldAnalysisError("Rule limitations must be a list")
    limitations.append(
        "Operator confirmation selects this expectation; original source conflicts and provenance "
        "remain recorded, and the decision does not authenticate an official journal requirement."
    )
    rule["limitations"] = sorted(set(cast(list[str], limitations)))
    revised["version_id"] = world_version_id(revised)
    validate_world_for_execution(revised)
    return revised
