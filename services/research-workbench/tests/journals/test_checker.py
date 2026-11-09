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
    world_version_id,
)
from research_file_workbench.journals.revisions import revise_rule
from tests.journals.test_analysis import template_bytes


def _world(text):
    return analyze_world(
        "journal-test", "Test", [SourceInput("guide", "guide_text", text.encode())]
    )


def _result(sections=((11906, 16838, 1440, 1),)):
    return read_docx_bytes(template_bytes(sections), source_label="retained-manuscript")


def test_confirmed_guide_can_report_compliant_or_violation():
    world = _world(
        "All manuscript pages must use A4 paper.\nAll manuscript pages must use 2 columns."
    )
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


def test_missing_section_values_remain_cannot_determine():
    world = _world("All manuscript pages must have 1 inch margins on all sides.")
    result = check_world(world, _result(((11906, 16838, None, None),)))
    assert result["summary"]["cannot_determine"] == 4
    assert result["summary"]["compliant"] == 0


def test_conflicts_remain_cannot_determine():
    world = analyze_world(
        "journal-test",
        "Test",
        [
            SourceInput("a", "guide_text", b"All manuscript pages must use A4 paper."),
            SourceInput("b", "guide_text", b"All manuscript pages must use Letter paper."),
        ],
    )
    assert check_world(world, _result())["summary"]["cannot_determine"] == 2


def test_modified_world_is_refused_but_store_metadata_does_not_change_identity():
    world = _world("All manuscript pages must use A4 paper.")
    stored = {**world, "created_at": "stored-time", "version_ordinal": 1}
    result = _result()
    assert check_world(stored, result) == check_world(world, result)
    modified = deepcopy(world)
    modified["rules"][0]["expected"] = 999
    with pytest.raises(WorldAnalysisError, match="version"):
        check_world(modified, _result())


def test_scope_mismatch_is_not_checked():
    world = _world("All manuscript pages must use A4 paper.")
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
    result = check_world(_world("All manuscript pages must use A4 paper."), _result())
    assert result["rule_results"][0]["applicability"] == "APPLICABLE"


def test_manual_resolution_is_new_deterministic_and_keeps_source_conflict():
    world = analyze_world(
        "journal-test",
        "Test",
        [
            SourceInput("a", "guide_text", b"All manuscript pages must use A4 paper."),
            SourceInput("b", "guide_text", b"All manuscript pages must use Letter paper."),
        ],
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
    world = _world("All manuscript pages must use A4 paper.")
    with pytest.raises(WorldAnalysisError):
        revise_rule(world, world["rules"][0]["rule_id"], expected, reason, "operator")


def test_known_violation_survives_missing_geometry_in_another_section():
    world = _world("All manuscript pages must use 2 columns.")
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
        _world("All manuscript pages must use 1 column."),
        _result(((11906, 16838, 1440, 1), (11906, 16838, 1440, None))),
    )
    assert result["rule_results"][0]["verdict"] == "cannot_determine"
    assert result["summary"]["compliant"] == 0


def test_historical_world_identity_remains_readable_but_not_executable():
    from research_file_workbench.journals.models import validate_world_identity

    world = _world("All manuscript pages must use A4 paper.")
    world["analyzer_version"] = "journal-world-analyzer-1.0.0"
    world["version_id"] = world_version_id(world)
    validate_world_identity(world)
    with pytest.raises(WorldAnalysisError, match="reanalyze"):
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
        "template_confirmed",
    ],
)
def test_invalid_rehashed_world_cannot_enter_checker(damage):
    world = _world("All manuscript pages must use A4 paper.")
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
        rule["confirmation_method"] = "human_decision"
    else:
        world["sources"][0]["kind"] = "template_docx"
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

    world = _world("All manuscript pages must use 2 columns.")
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

    world = _world("All manuscript pages must use 2 columns.")
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

    world = _world("All manuscript pages must use A4 paper.")
    check = check_world(world, _result())
    check["summary"]["compliant"] = True
    with pytest.raises(WorldAnalysisError, match="integer counts"):
        validate_check_result(check, world)
    check = check_world(world, _result())
    check["rule_results"][1]["findings"][0]["locator"] = "word/document.xml#sectPr[99]"
    with pytest.raises(WorldAnalysisError, match="section locators"):
        validate_check_result(check, world)


def test_negative_declared_margin_is_retained_as_observation_without_silent_null():
    result = check_world(
        _world("All manuscript pages must have 1 inch margins on all sides."),
        _result(((11906, 16838, -1440, 1),)),
    )
    assert result["rule_results"][0]["findings"][0]["observed"] == -1440
    assert result["rule_results"][0]["verdict"] == "violation"


def test_body_font_size_rule_compares_dominant_declared_runs():
    from tests.journals.test_analysis import docx_bytes

    body = (
        '<w:p><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>body text</w:t></w:r></w:p>'
        "<w:p><w:pPr><w:sectPr>"
        '<w:pgSz w:w="11906" w:h="16838"/><w:cols w:num="2"/>'
        "</w:sectPr></w:pPr></w:p>"
    )
    world = _world(
        "A double column page is defined as a 7.875″ x 10.75″ page with 9.5-point type "
        "and 11.5-point vertical spacing."
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
    world = _world(
        "A double column page is defined as a 7.875″ x 10.75″ page with 9.5-point type "
        "and 11.5-point vertical spacing."
    )
    check = check_world(world, _result())
    font = next(r for r in check["rule_results"] if r["property"] == "body_font_size_halfpoints")
    assert font["verdict"] == "cannot_determine"
    # The remaining violations belong to the page-size and column rules of the same world.
    assert font["findings"][0]["observed"] is None
