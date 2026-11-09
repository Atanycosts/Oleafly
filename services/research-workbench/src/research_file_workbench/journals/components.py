"""Strict declarative journal rule components with explicit applicability and provenance."""

from research_file_workbench.common.json_io import JsonObject, decode_json_object
from research_file_workbench.journals.models import (
    COMPONENT_SCHEMA_VERSION,
    SourceInput,
    WorldAnalysisError,
    coverage_gap,
    property_unit,
    require_expected,
    require_identifier,
    require_keys,
    require_object,
    require_objects,
    require_strings,
    require_text,
)


def analyze_component(
    source: SourceInput, journal_id: str, scope: JsonObject
) -> tuple[list[JsonObject], list[JsonObject]]:
    """Validate one declarative component; imported assertions remain candidates."""
    document = decode_json_object(source.content)
    require_keys(
        document,
        {
            "schema_version",
            "component_id",
            "component_version",
            "applicability",
            "sources",
            "rules",
        },
    )
    if document["schema_version"] != COMPONENT_SCHEMA_VERSION:
        raise WorldAnalysisError("Unsupported rule-component schema version")
    require_identifier(document["component_id"], "component_id")
    require_text(document["component_version"], "component_version")
    applicability = require_object(document["applicability"], "component applicability")
    require_keys(applicability, {"journal_ids", "article_types", "stages", "languages", "basis"})
    require_text(applicability["basis"], "applicability basis")
    applicable = True
    for key, actual in (
        ("journal_ids", journal_id),
        ("article_types", scope["article_type"]),
        ("stages", scope["stage"]),
        ("languages", scope["language"]),
    ):
        declared = _unique_strings(applicability[key], key)
        applicable = applicable and actual in declared
    provenance: dict[str, JsonObject] = {}
    for record in require_objects(document["sources"], "component sources", nonempty=True):
        require_keys(record, {"source_id", "title", "locator", "quote"})
        identity = require_identifier(record["source_id"], "component source_id")
        if identity in provenance:
            raise WorldAnalysisError("Duplicate component source reference")
        for key in ("title", "locator", "quote"):
            require_text(record[key], key)
        provenance[identity] = record
    observations: list[JsonObject] = []
    rules = require_objects(document["rules"], "component rules", nonempty=True)
    for index, rule in enumerate(rules, start=1):
        require_keys(rule, {"property", "expected", "unit", "source_refs"})
        property_name = require_text(rule["property"], "property")
        expected = require_expected(property_name, rule["expected"])
        if rule["unit"] != property_unit(property_name):
            raise WorldAnalysisError("Component unit does not match its geometry property")
        refs = _unique_strings(rule["source_refs"], "source_refs")
        if any(reference not in provenance for reference in refs):
            raise WorldAnalysisError("Component rule names an absent provenance reference")
        evidence: list[JsonObject] = [
            {
                "source_id": source.source_id,
                "locator": f"json:/rules/{index - 1}",
                "quote": f"{property_name} = {expected} {rule['unit']}",
            }
        ]
        evidence.extend(
            {
                "source_id": source.source_id,
                "locator": f"json:/sources/{list(provenance).index(reference)}",
                "quote": provenance[reference]["quote"],
            }
            for reference in refs
        )
        observations.append(
            {
                "property": property_name,
                "expected": expected,
                "basis_status": "candidate",
                "confirmation_method": "declared_component_candidate",
                "evidence": evidence,
                "limitations": [
                    "Component provenance and applicability are supplied declarations, not "
                    "authenticated journal requirements.",
                    f"Applicability basis: {applicability['basis']}",
                ],
            }
        )
    if not applicable:
        return [], [
            coverage_gap(
                "component_scope_mismatch",
                "This component does not explicitly apply to the selected journal context.",
                source_id=source.source_id,
            )
        ]
    return observations, []


def _unique_strings(value: object, label: str) -> list[str]:
    result = require_strings(value, label)
    if not result:
        raise WorldAnalysisError(f"Component {label} must be a nonempty string list")
    if len(result) != len(set(result)):
        raise WorldAnalysisError(f"Component {label} must not contain duplicate references")
    return result
