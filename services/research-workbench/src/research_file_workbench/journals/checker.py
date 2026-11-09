"""Check declared section geometry while preserving rule basis and incomplete coverage."""

from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxReadResult
from research_file_workbench.journals.models import (
    CHECKER_VERSION,
    WorldAnalysisError,
    coverage_gap,
    require_expected,
    require_keys,
    require_object,
    require_objects,
    require_strings,
    require_text,
    validate_world_for_execution,
    validate_world_identity,
)

_VERDICTS = (
    "compliant",
    "violation",
    "observed_match",
    "observed_difference",
    "cannot_determine",
    "not_checked",
)
_HISTORICAL_CHECKER_VERSION = "journal-geometry-checker-1.0.0"


def check_world(world: JsonObject, result: DocxReadResult) -> JsonObject:
    """Check observed section values; missing observations never imply satisfied requirements."""
    validate_world_for_execution(world)
    scope = cast(JsonObject, world["scope"])
    results: list[JsonObject] = []
    summary = {verdict: 0 for verdict in _VERDICTS}
    gaps = list(cast(list[JsonObject], world["coverage_gaps"]))
    if not result.sections:
        gaps.append(
            coverage_gap(
                "manuscript_sections_missing", "The manuscript has no declared section geometry."
            )
        )
    for rule in require_objects(world["rules"], "world rules"):
        property_name = cast(str, rule["property"])
        basis = cast(str, rule["basis_status"])
        applicable = rule["scope"] == {**scope, "section_scope": "all_sections"}
        findings: list[JsonObject] = []
        observed_count = 0
        mismatches = 0
        limitations: list[str] = []
        if applicable and basis != "conflict":
            expected = cast(int, rule["expected"])
            for section in result.sections:
                observed = getattr(section, property_name)
                finding_verdict = _finding_verdict(basis, observed, expected)
                if observed is not None:
                    observed_count += 1
                    mismatches += observed != expected
                findings.append(
                    {
                        "section_index": section.section_index,
                        "locator": section.node_locator,
                        "observed": observed,
                        "expected": expected,
                        "verdict": finding_verdict,
                        "message": "No supported source value; computed layout is unavailable."
                        if observed is None
                        else "Declared source value matches the expectation."
                        if observed == expected
                        else "Declared source value differs from the expectation.",
                    }
                )
            if observed_count != len(result.sections) or not result.sections:
                limitations.append(
                    "At least one section value is absent; no computed default is inferred."
                )
        elif not applicable:
            limitations.append("Rule scope is outside this checker's selected manuscript context.")
        else:
            limitations.append(
                "Conflicting supplied expectations require a separate evidence decision."
            )
        verdict = _aggregate_verdict(
            basis, applicable, len(result.sections), observed_count, mismatches
        )
        summary[verdict] += 1
        results.append(
            {
                "rule_id": rule["rule_id"],
                "property": property_name,
                "basis_status": basis,
                "applicability": "APPLICABLE" if applicable else "NOT_APPLICABLE",
                "verdict": verdict,
                "findings": findings,
                "coverage": {
                    "total_sections": len(result.sections),
                    "observed_sections": observed_count,
                    "missing_sections": len(result.sections) - observed_count,
                },
                "limitations": limitations,
            }
        )
    check: JsonObject = {
        "world_version_id": world["version_id"],
        "source_sha256": result.source_sha256,
        "checker_version": CHECKER_VERSION,
        "scope": scope,
        "rule_results": results,
        "summary": summary,
        "coverage_gaps": gaps,
        "limitations": [
            "This check compares declared OOXML section values only; computed layout and "
            "rendered appearance are not verified.",
            "Page-geometry results do not establish complete journal compliance or "
            "scientific correctness.",
        ],
    }
    validate_check_result(check, world)
    return check


def _finding_verdict(basis: str, observed: object, expected: int) -> str:
    if observed is None:
        return "cannot_determine"
    if basis == "confirmed":
        return "compliant" if observed == expected else "violation"
    return "observed_match" if observed == expected else "observed_difference"


def _aggregate_verdict(
    basis: str,
    applicable: bool,
    total: int,
    observed: int,
    mismatches: int,
    *,
    historical: bool = False,
) -> str:
    if not applicable:
        return "not_checked"
    if basis == "conflict":
        return "cannot_determine"
    incomplete = observed != total or total == 0
    if historical and incomplete:
        return "cannot_determine"
    if mismatches:
        return "violation" if basis == "confirmed" else "observed_difference"
    if incomplete:
        return "cannot_determine"
    return "compliant" if basis == "confirmed" else "observed_match"


def validate_check_result(check: JsonObject, world: JsonObject) -> None:
    """Validate retained check facts without rerunning a historical method or authenticating bytes.

    Service-added project, baseline, binding and timestamp fields are outside this domain payload.
    Historical 1.0 records retain their documented missing-value aggregation and absent per-finding
    verdict; new checks use the current method and explicit finding verdicts.
    """
    validate_world_identity(world)
    method = require_text(check.get("checker_version"), "checker version")
    if method not in {CHECKER_VERSION, _HISTORICAL_CHECKER_VERSION}:
        raise WorldAnalysisError("Unsupported stored checker method")
    historical = method == _HISTORICAL_CHECKER_VERSION
    if check.get("world_version_id") != world["version_id"] or check.get("scope") != world["scope"]:
        raise WorldAnalysisError("Check world identity or scope differs from its world")
    source_hash = require_text(check.get("source_sha256"), "manuscript source digest")
    if len(source_hash) != 64 or any(
        character not in "0123456789abcdef" for character in source_hash
    ):
        raise WorldAnalysisError("Check source digest is not a lowercase SHA-256")
    rules = {
        cast(str, rule["rule_id"]): rule for rule in require_objects(world["rules"], "world rules")
    }
    records = require_objects(check.get("rule_results"), "check rule results")
    seen: set[str] = set()
    counts = {verdict: 0 for verdict in _VERDICTS}
    section_count: int | None = None
    source_sections: dict[int, str] | None = None
    for record in records:
        require_keys(
            record,
            {
                "rule_id",
                "property",
                "basis_status",
                "applicability",
                "verdict",
                "findings",
                "coverage",
                "limitations",
            },
        )
        identity = require_text(record["rule_id"], "checked rule ID")
        if identity in seen or identity not in rules:
            raise WorldAnalysisError("Check contains duplicate or unknown rule identities")
        seen.add(identity)
        rule = rules[identity]
        if any(record[key] != rule[key] for key in ("property", "basis_status")):
            raise WorldAnalysisError("Check property or rule basis differs from its world")
        applicable = rule["scope"] == {
            **cast(JsonObject, world["scope"]),
            "section_scope": "all_sections",
        }
        if record["applicability"] != ("APPLICABLE" if applicable else "NOT_APPLICABLE"):
            raise WorldAnalysisError("Check applicability differs from its rule scope")
        coverage = require_object(record["coverage"], "check coverage")
        require_keys(coverage, {"total_sections", "observed_sections", "missing_sections"})
        if any(type(value) is not int or value < 0 for value in coverage.values()):
            raise WorldAnalysisError("Check coverage must contain nonnegative integers")
        total = cast(int, coverage["total_sections"])
        observed = cast(int, coverage["observed_sections"])
        if observed > total or observed + cast(int, coverage["missing_sections"]) != total:
            raise WorldAnalysisError("Check coverage counts disagree")
        if section_count is not None and total != section_count:
            raise WorldAnalysisError("Checked rules disagree about manuscript section count")
        section_count = total
        findings = require_objects(record["findings"], "check findings")
        basis = cast(str, rule["basis_status"])
        calculated_observed = 0
        mismatches = 0
        indices: set[int] = set()
        locators: set[str] = set()
        section_locators: dict[int, str] = {}
        for finding in findings:
            keys = {"section_index", "locator", "observed", "expected", "message"}
            require_keys(finding, keys if historical else keys | {"verdict"})
            index = finding["section_index"]
            locator = require_text(finding["locator"], "finding locator")
            if type(index) is not int or index < 1 or index in indices or locator in locators:
                raise WorldAnalysisError(
                    "Check findings have invalid or duplicate section identities"
                )
            indices.add(index)
            locators.add(locator)
            section_locators[index] = locator
            require_text(finding["message"], "finding message")
            if finding["expected"] != rule["expected"]:
                raise WorldAnalysisError("Finding expectation differs from its world rule")
            expected = require_expected(cast(str, rule["property"]), finding["expected"])
            value = finding["observed"]
            if value is not None:
                if type(value) is not int:
                    raise WorldAnalysisError("Observed source geometry must be an integer or null")
                calculated_observed += 1
                mismatches += value != expected
            if not historical and finding["verdict"] != _finding_verdict(basis, value, expected):
                raise WorldAnalysisError("Finding verdict differs from its observed geometry")
        should_compare = applicable and basis != "conflict"
        if len(findings) != (total if should_compare else 0) or calculated_observed != observed:
            raise WorldAnalysisError("Check findings do not match its declared coverage")
        if should_compare and indices != set(range(1, total + 1)):
            raise WorldAnalysisError("Check findings omit a source section")
        if should_compare:
            if source_sections is not None and section_locators != source_sections:
                raise WorldAnalysisError("Checked rules disagree about source section locators")
            source_sections = section_locators
        verdict = _aggregate_verdict(
            basis, applicable, total, observed, mismatches, historical=historical
        )
        if record["verdict"] != verdict:
            raise WorldAnalysisError("Check verdict does not match its findings and coverage")
        counts[verdict] += 1
        require_strings(record["limitations"], "check rule limitations")
    summary = require_object(check.get("summary"), "check summary")
    if any(type(value) is not int or value < 0 for value in summary.values()):
        raise WorldAnalysisError("Check summary must contain nonnegative integer counts")
    if seen != set(rules) or summary != counts:
        raise WorldAnalysisError("Check rule set or summary differs from its exact results")
    expected_gaps = list(cast(list[JsonObject], world["coverage_gaps"]))
    if section_count == 0:
        expected_gaps.append(
            coverage_gap(
                "manuscript_sections_missing", "The manuscript has no declared section geometry."
            )
        )
    gaps = require_objects(check.get("coverage_gaps"), "check coverage gaps")
    if section_count is not None and gaps != expected_gaps:
        raise WorldAnalysisError("Check coverage gaps differ from its world and observed sections")
    require_strings(check.get("limitations"), "check limitations")
