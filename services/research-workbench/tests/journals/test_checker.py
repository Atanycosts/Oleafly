"""Declared geometry verdicts preserve basis, uncertainty, and immutable decisions."""

from copy import deepcopy

import pytest

from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.journals.analysis import analyze_world
from research_file_workbench.journals.checker import check_world
from research_file_workbench.journals.models import (
    SourceInput,
    WorldAnalysisError,
    record_digest,
    validate_world_identity,
    world_version_id,
)
from research_file_workbench.journals.revisions import revise_rule
from tests.journals.test_analysis import (
    component_bytes,
    declarative_world,
    docx_bytes,
    explicit_world,
    template_bytes,
)


def _world(*requirements):
    return explicit_world(list(requirements))


def _conflicting_world(first, second, *, first_quote="First source", second_quote="Second source"):
    return analyze_world(
        "journal-test",
        "Test",
        [
            SourceInput(
                "first.json",
                "rule_component_json",
                component_bytes(first, quote=first_quote),
            ),
            SourceInput(
                "second.json",
                "rule_component_json",
                component_bytes(second, quote=second_quote),
            ),
        ],
    )


def _result(sections=((11906, 16838, 1440, 1),)):
    return read_docx_bytes(template_bytes(sections), source_label="retained-manuscript")


def test_explicit_rules_can_report_compliant_or_violation():
    world = _world(("page_width_twips", 11906), ("columns", 2))
    check = check_world(world, _result())
    by_property = {rule["property"]: rule for rule in check["rule_results"]}
    assert by_property["page_width_twips"]["verdict"] == "compliant"
    assert by_property["columns"]["verdict"] == "violation"
    assert by_property["columns"]["findings"][0]["observed"] == 1
    assert check["summary"]["violation"] == 1


def test_template_candidate_never_becomes_violation():
    world = analyze_world(
        "journal-test",
        "Test",
        [SourceInput("template", "template_docx", template_bytes(((11906, 16838, 1440, 2),)))],
    )
    result = check_world(world, _result())
    assert result["summary"]["violation"] == 0
    assert result["summary"]["observed_difference"] == 1
    assert result["summary"]["observed_match"] == 6


def test_font_acquisition_requirement_does_not_claim_manuscript_compliance():
    world = _world(
        ("page_width_twips", 11906),
        ("body_font_family", "Times New Roman"),
    )
    result = check_world(world, _result())
    font = next(item for item in result["rule_results"] if item["property"] == "body_font_family")
    assert font["basis_status"] == "confirmed"
    assert font["applicability"] == "APPLICABLE"
    assert font["verdict"] == "not_checked"
    assert font["findings"] == []
    assert font["coverage"]["observed_sections"] == 0
    assert any("exact font acquisition" in item for item in font["limitations"])
    assert result["summary"]["compliant"] == 1


def test_conflicting_font_sources_keep_quotes_until_an_explicit_versioned_decision():
    world = _conflicting_world(
        [("body_font_family", "Times New Roman")],
        [("body_font_family", "PT Serif")],
        first_quote="Body text must use Times New Roman font.",
        second_quote="Body text must use PT Serif font.",
    )
    rule = world["rules"][0]
    assert rule["basis_status"] == "conflict"
    assert rule["expected"] is None
    revised = revise_rule(world, rule["rule_id"], "Times New Roman", "Confirmed source", "editor")
    assert revised["rules"][0]["expected"] == "Times New Roman"
    assert revised["rules"][0]["evidence"] == rule["evidence"]
    assert world["rules"][0]["expected"] is None


def test_missing_section_values_remain_cannot_determine():
    world = _world(
        ("top_margin_twips", 1440),
        ("right_margin_twips", 1440),
        ("bottom_margin_twips", 1440),
        ("left_margin_twips", 1440),
    )
    result = check_world(world, _result(((11906, 16838, None, None),)))
    assert result["summary"]["cannot_determine"] == 4
    assert result["summary"]["compliant"] == 0


def test_conflicts_remain_cannot_determine():
    world = _conflicting_world(
        [("page_width_twips", 11906), ("page_height_twips", 16838)],
        [("page_width_twips", 12240), ("page_height_twips", 15840)],
    )
    assert check_world(world, _result())["summary"]["cannot_determine"] == 2


def test_modified_world_is_refused_but_store_metadata_does_not_change_identity():
    world = _world(("page_width_twips", 11906))
    stored = {**world, "created_at": "stored-time", "version_ordinal": 1}
    result = _result()
    assert check_world(stored, result) == check_world(world, result)
    modified = deepcopy(world)
    modified["rules"][0]["expected"] = 999
    with pytest.raises(WorldAnalysisError, match="version"):
        check_world(modified, _result())


def test_scope_mismatch_is_not_checked():
    world = declarative_world([("page_width_twips", 11906)])
    world["rules"][0]["scope"]["stage"] = "revision"
    rule = world["rules"][0]
    rule["rule_id"] = "rule-" + record_digest(
        {"journal_id": world["journal_id"], "scope": rule["scope"], "property": rule["property"]}
    )
    world["version_id"] = world_version_id(world)
    result = check_world(world, _result())["rule_results"][0]
    assert result["verdict"] == "not_checked"
    assert result["applicability"] == "NOT_APPLICABLE"


def test_applicability_is_explicit_for_a_supported_rule():
    result = check_world(_world(("page_width_twips", 11906)), _result())
    assert result["rule_results"][0]["applicability"] == "APPLICABLE"


def test_manual_resolution_is_new_deterministic_and_keeps_source_conflict():
    world = _conflicting_world(
        [("page_width_twips", 11906)],
        [("page_width_twips", 12240)],
        first_quote="All manuscript pages must use A4 paper.",
        second_quote="All manuscript pages must use Letter paper.",
    )
    before = deepcopy(world)
    rule_id = world["rules"][0]["rule_id"]
    revised = revise_rule(
        world, rule_id, 11906, "Use the supplied initial-submission rule", "local-editor"
    )
    assert world == before
    assert revised == revise_rule(
        world, rule_id, 11906, "Use the supplied initial-submission rule", "local-editor"
    )
    assert revised["version_id"] != world["version_id"]
    assert revised["rules"][0]["rule_id"] == rule_id
    assert revised["rules"][0]["evidence"] == world["rules"][0]["evidence"]
    assert revised["rules"][0]["resolution"]["previous_basis_status"] == "conflict"
    assert revised["rules"][0]["confirmation_method"] == "human_decision"
    assert revised["manual_decisions"][0]["base_version_id"] == world["version_id"]
    assert check_world(revised, _result())["rule_results"][0]["verdict"] == "compliant"


@pytest.mark.parametrize("expected,reason", [(True, "reason"), (-1, "reason"), (12, "")])
def test_invalid_manual_decisions_are_refused(expected, reason):
    world = declarative_world([("page_width_twips", 11906)])
    with pytest.raises(WorldAnalysisError):
        revise_rule(world, world["rules"][0]["rule_id"], expected, reason, "operator")


def test_known_violation_survives_missing_geometry_in_another_section():
    world = _world(("columns", 2))
    result = check_world(world, _result(((11906, 16838, 1440, 1), (11906, 16838, 1440, None))))
    rule = result["rule_results"][0]
    assert rule["verdict"] == "violation"
    assert [finding["verdict"] for finding in rule["findings"]] == ["violation", "cannot_determine"]
    assert rule["coverage"] == {"total_sections": 2, "observed_sections": 1, "missing_sections": 1}
    assert rule["limitations"]


def test_known_candidate_difference_survives_missing_geometry_without_violation():
    world = analyze_world(
        "journal-test",
        "Test",
        [SourceInput("template", "template_docx", template_bytes(((11906, 16838, 1440, 2),)))],
    )
    result = check_world(world, _result(((11906, 16838, 1440, 1), (11906, 16838, 1440, None))))
    column = next(rule for rule in result["rule_results"] if rule["property"] == "columns")
    assert column["verdict"] == "observed_difference"
    assert [finding["verdict"] for finding in column["findings"]] == [
        "observed_difference",
        "cannot_determine",
    ]
    assert result["summary"]["violation"] == 0


def test_matching_observation_plus_missing_section_is_not_compliant():
    result = check_world(
        _world(("columns", 1)),
        _result(((11906, 16838, 1440, 1), (11906, 16838, 1440, None))),
    )
    assert result["rule_results"][0]["verdict"] == "cannot_determine"
    assert result["summary"]["compliant"] == 0


def test_historical_world_identity_remains_readable_but_not_executable():
    world = _world(("page_width_twips", 11906))
    world["analyzer_version"] = "journal-world-analyzer-1.0.0"
    world["version_id"] = world_version_id(world)
    validate_world_identity(world)
    with pytest.raises(WorldAnalysisError, match="reanalyze"):
        check_world(world, _result())


def test_retired_guide_pattern_world_is_readable_but_not_executable():
    world = deepcopy(_world(("page_width_twips", 11906)))
    world["rules"][0]["confirmation_method"] = "explicit_supplied_guide_pattern"
    world["version_id"] = world_version_id(world)
    validate_world_identity(world)
    with pytest.raises(WorldAnalysisError, match="retired"):
        check_world(world, _result())


@pytest.mark.parametrize(
    "damage",
    [
        "property",
        "basis",
        "duplicate_rule",
        "missing_evidence",
        "evidence_source",
        "scope_shape",
        "human_without_decision",
        "guide_pattern",
    ],
)
def test_invalid_rehashed_world_cannot_enter_checker(damage):
    world = deepcopy(_world(("page_width_twips", 11906)))
    rule = world["rules"][0]
    if damage == "property":
        rule["property"] = "executable_script"
    elif damage == "basis":
        rule["basis_status"] = []
    elif damage == "duplicate_rule":
        world["rules"].append(deepcopy(rule))
    elif damage == "missing_evidence":
        rule["evidence"] = []
    elif damage == "evidence_source":
        rule["evidence"][0]["source_id"] = "source-" + "0" * 64
    elif damage == "scope_shape":
        rule["scope"]["extra"] = "not allowed"
    elif damage == "human_without_decision":
        rule.pop("resolution")
    else:
        rule["confirmation_method"] = "explicit_supplied_guide_pattern"
    world["version_id"] = world_version_id(world)
    with pytest.raises(WorldAnalysisError):
        check_world(world, _result())


@pytest.mark.parametrize(
    "damage",
    [
        "finding_verdict",
        "rule_verdict",
        "summary",
        "coverage",
        "unknown_rule",
        "duplicate_section",
        "wrong_expected",
    ],
)
def test_check_validator_rejects_inconsistent_retained_results(damage):
    from research_file_workbench.journals.checker import validate_check_result

    world = _world(("columns", 2))
    check = check_world(world, _result(((11906, 16838, 1440, 1), (11906, 16838, 1440, None))))
    rule = check["rule_results"][0]
    if damage == "finding_verdict":
        rule["findings"][0]["verdict"] = "compliant"
    elif damage == "rule_verdict":
        rule["verdict"] = "compliant"
    elif damage == "summary":
        check["summary"]["violation"] = 99
    elif damage == "coverage":
        rule["coverage"]["missing_sections"] = 0
    elif damage == "unknown_rule":
        rule["rule_id"] = "rule-unknown"
    elif damage == "duplicate_section":
        rule["findings"][1]["section_index"] = 1
    else:
        rule["findings"][0]["expected"] = 42
    with pytest.raises(WorldAnalysisError):
        validate_check_result(check, world)


def test_historical_check_retains_prior_missing_value_semantics():
    from research_file_workbench.journals.checker import validate_check_result

    world = _world(("columns", 2))
    check = check_world(world, _result(((11906, 16838, 1440, 1), (11906, 16838, 1440, None))))
    check["checker_version"] = "journal-geometry-checker-1.0.0"
    rule = check["rule_results"][0]
    for finding in rule["findings"]:
        finding.pop("verdict")
    rule["verdict"] = "cannot_determine"
    check["summary"]["violation"] = 0
    check["summary"]["cannot_determine"] = 1
    validate_check_result(check, world)


def test_retained_summary_booleans_and_cross_rule_locator_drift_are_refused():
    from research_file_workbench.journals.checker import validate_check_result

    world = _world(("page_width_twips", 11906), ("page_height_twips", 16838))
    check = check_world(world, _result())
    check["summary"]["compliant"] = True
    with pytest.raises(WorldAnalysisError, match="integer counts"):
        validate_check_result(check, world)
    check = check_world(world, _result())
    check["rule_results"][0]["findings"][0]["locator"] = "word/document.xml#sectPr[99]"
    with pytest.raises(WorldAnalysisError, match="section locators"):
        validate_check_result(check, world)


def test_negative_declared_margin_is_retained_as_observation_without_silent_null():
    result = check_world(
        _world(("left_margin_twips", 1440)),
        _result(((11906, 16838, -1440, 1),)),
    )
    assert result["rule_results"][0]["findings"][0]["observed"] == -1440
    assert result["rule_results"][0]["verdict"] == "violation"


def test_body_font_size_rule_compares_dominant_declared_runs():
    body = (
        '<w:p><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>body text</w:t></w:r></w:p>'
        "<w:p><w:pPr><w:sectPr>"
        '<w:pgSz w:w="11906" w:h="16838"/><w:cols w:num="2"/>'
        "</w:sectPr></w:pPr></w:p>"
    )
    world = _world(
        ("body_font_size_halfpoints", 19),
        ("body_line_spacing_twips", 230),
    )
    check = check_world(world, read_docx_bytes(docx_bytes(body), source_label="m"))
    by_property = {rule["property"]: rule for rule in check["rule_results"]}
    font = by_property["body_font_size_halfpoints"]
    assert font["verdict"] == "violation"
    assert font["findings"][0]["observed"] == 18
    assert font["findings"][0]["expected"] == 19
    spacing = by_property["body_line_spacing_twips"]
    assert spacing["verdict"] == "cannot_determine"
    assert spacing["findings"][0]["observed"] is None


def test_body_font_size_without_declared_runs_stays_cannot_determine():
    world = _world(("body_font_size_halfpoints", 19))
    check = check_world(world, _result())
    font = next(r for r in check["rule_results"] if r["property"] == "body_font_size_halfpoints")
    assert font["verdict"] == "cannot_determine"
    assert font["findings"][0]["observed"] is None
