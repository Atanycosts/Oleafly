"""Object-level template verdicts using retained core-derived facts."""

from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.journals.models import (
    WorldAnalysisError,
    require_object,
    require_objects,
)
from research_file_workbench.journals.template_models import TEMPLATE_CHECKER_VERSION

VERDICTS = (
    "compliant",
    "violation",
    "cannot_determine",
    "observed_match",
    "observed_difference",
    "not_checked",
)


def compare_world(
    world: JsonObject, template: JsonObject, manuscript: JsonObject, source_bytes: bytes
) -> JsonObject:
    from research_file_workbench.journals.template_compare import compare_template

    findings = compare_template(template, manuscript)
    finding_summary = {
        verdict: sum(item["verdict"] == verdict for item in findings) for verdict in VERDICTS
    }
    records = []
    summary = dict.fromkeys(VERDICTS, 0)
    for rule in require_objects(world["rules"], "rules"):
        if rule["property"] != "object_format":
            continue
        scope = require_object(rule["scope"], "selector")
        selected = [
            item
            for item in findings
            if item["kind"] == scope["kind"] and item["role"] == scope["role"]
        ]
        verdict = (
            "observed_difference"
            if any(item["verdict"] == "observed_difference" for item in selected)
            else "cannot_determine"
            if not selected or any(item["verdict"] == "cannot_determine" for item in selected)
            else "observed_match"
        )
        summary[verdict] += 1
        records.append(
            {
                "rule_id": rule["rule_id"],
                "property": rule["property"],
                "basis_status": "confirmed",
                "applicability": "APPLICABLE",
                "verdict": verdict,
                "findings": [],
                "finding_selector": dict(scope),
                "finding_summary": {
                    verdict: sum(item["verdict"] == verdict for item in selected)
                    for verdict in VERDICTS
                },
                "coverage": {"total_objects": len(selected)},
                "limitations": [],
            }
        )
    guide_rules = [
        rule
        for rule in require_objects(world["rules"], "rules")
        if rule["property"] != "object_format"
    ]
    if guide_rules:
        from research_file_workbench.docx.reader import read_docx_bytes
        from research_file_workbench.journals.checker import check_world

        # The guide's retained rules use the existing checker rather than template heuristics.
        guide_world = dict(world)
        guide_world.pop("template")
        from research_file_workbench.docx.report import READER_VERSION
        from research_file_workbench.journals.models import ANALYZER_VERSION, world_version_id

        guide_world["sources"] = [
            item
            for item in require_objects(world["sources"], "sources")
            if item["kind"] in {"guide_text", "guide_docx", "guide_pdf", "rule_component_json"}
        ]
        guide_source_ids = {
            item["source_id"] for item in require_objects(guide_world["sources"], "guide sources")
        }
        guide_world["coverage_gaps"] = [
            gap
            for gap in require_objects(world["coverage_gaps"], "coverage gaps")
            if gap["source_id"] is None or gap["source_id"] in guide_source_ids
        ]
        guide_world["rules"] = guide_rules
        guide_world["analyzer_version"] = ANALYZER_VERSION
        guide_world["reader_version"] = READER_VERSION
        guide_world["version_id"] = world_version_id(guide_world)
        guide_check = check_world(
            guide_world, read_docx_bytes(source_bytes, source_label="template-comparison-baseline")
        )
        records.extend(require_objects(guide_check["rule_results"], "guide results"))
        for verdict, count in require_object(guide_check["summary"], "guide summary").items():
            summary[verdict] += cast(int, count)
    return {
        "world_version_id": world["version_id"],
        "source_sha256": manuscript["source_sha256"],
        "checker_version": TEMPLATE_CHECKER_VERSION,
        "scope": world["scope"],
        "rule_results": records,
        "summary": summary,
        "coverage_gaps": world["coverage_gaps"],
        "limitations": [],
        "template_comparison": {
            "schema_version": 1,
            "template_source_sha256": template["source_sha256"],
            "source_sha256": manuscript["source_sha256"],
            "template_engine": template["engine"],
            "engine": manuscript["engine"],
            "findings": findings,
            "finding_summary": finding_summary,
            "unsupported": manuscript["unsupported"],
        },
    }


def validate_template_check(check: JsonObject, world: JsonObject) -> None:
    if check.get("world_version_id") != world["version_id"] or check.get("scope") != world["scope"]:
        raise WorldAnalysisError("Template check identifies another world")
    comparison = require_object(check.get("template_comparison"), "template comparison")
    if comparison.get("source_sha256") != check.get("source_sha256"):
        raise WorldAnalysisError("Template comparison source binding differs")
    rules = {str(rule["rule_id"]): rule for rule in require_objects(world["rules"], "rules")}
    page = require_objects(comparison.get("findings"), "object findings")
    total = comparison.get("total")
    if type(total) is not int or total < len(page):
        raise WorldAnalysisError("Template findings page has invalid total")
    require_object(comparison.get("finding_summary"), "finding summary")
    seen: set[str] = set()
    summary = dict.fromkeys(VERDICTS, 0)
    for result in require_objects(check.get("rule_results"), "rule results"):
        identity = str(result.get("rule_id"))
        if identity in seen or identity not in rules or result.get("verdict") not in VERDICTS:
            raise WorldAnalysisError("Template check contains invalid rule results")
        seen.add(identity)
        summary[cast(str, result["verdict"])] += 1
        if rules[identity]["property"] != "object_format":
            continue
        counts = require_object(result.get("finding_summary"), "rule finding summary")
        if any(type(value) is not int or value < 0 for value in counts.values()):
            raise WorldAnalysisError("Rule finding counts must be nonnegative")
        if result.get("finding_selector") != rules[identity]["scope"]:
            raise WorldAnalysisError("Template finding selector differs from its requirement")
    for item in page:
        for field in (
            "case_id",
            "object_id",
            "kind",
            "role",
            "part",
            "path",
            "property_path",
            "observed",
            "expected",
            "template_object_ids",
            "verdict",
        ):
            if field not in item:
                raise WorldAnalysisError(f"Object finding is missing {field}")
    if seen != set(rules) or check.get("summary") != summary:
        raise WorldAnalysisError("Template check summary or requirements differ")
