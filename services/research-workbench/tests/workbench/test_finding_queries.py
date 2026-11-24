"""Focused projections over retained template findings."""

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.workbench.finding_queries import (
    build_finding_query_view,
    candidate_findings_result,
    finding_verification_result,
    remaining_review_groups,
    with_line_spacing_rules,
)

MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math"
WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main"


def xml_object(
    object_id,
    path,
    kind,
    role,
    namespace_uri,
    local_name,
    *,
    properties=None,
    text="",
    paragraph_id=None,
    table_context=None,
    para_id=None,
    region=None,
):
    result: JsonObject = {
        "object_id": object_id,
        "part": "/word/document.xml",
        "path": path,
        "kind": kind,
        "role": role,
        "role_basis": [],
        "text": text,
        "properties": properties or {},
        "declared": {
            "namespace_uri": namespace_uri,
            "local_name": local_name,
            "attributes": ([{"localName": "paraId", "value": para_id}] if para_id else []),
        },
        "evidence": {"paragraph_object_id": paragraph_id} if paragraph_id else {},
    }
    if table_context is not None:
        result["table_context"] = table_context
    if region is not None:
        result["region"] = region
    return result


def finding(object_id, path, kind, role, property_path="", *, verdict="cannot_determine", **extra):
    return {
        "case_id": f"case-{object_id}-{property_path}",
        "object_id": object_id,
        "kind": kind,
        "role": role,
        "part": "/word/document.xml",
        "path": path,
        "property_path": property_path,
        "observed": None,
        "expected": None,
        "expected_value_count": 0,
        "template_object_ids": [],
        "verdict": verdict,
        **extra,
    }


def view(snapshot, findings):
    return build_finding_query_view(
        {
            "check_id": "check-focused",
            "baseline_id": "baseline-focused",
            "source_sha256": "a" * 64,
        },
        snapshot,
        findings,
    )


def test_xml_declared_formula_and_drawing_descendants_group_into_outer_objects():
    formula_para = xml_object(
        "/word/document.xml#0.0",
        [0, 0],
        "paragraph",
        "body",
        WORD,
        "p",
        text="Equation paragraph",
        para_id="11111111",
    )
    formula = xml_object(
        "/word/document.xml#0.0.0",
        [0, 0, 0],
        "unsupported_node",
        "unknown",
        MATH,
        "oMath",
        paragraph_id=formula_para["object_id"],
    )
    formula_run = xml_object(
        "/word/document.xml#0.0.0.0",
        [0, 0, 0, 0],
        "unsupported_node",
        "unknown",
        MATH,
        "r",
        paragraph_id=formula_para["object_id"],
    )
    formula_text = xml_object(
        "/word/document.xml#0.0.0.0.0",
        [0, 0, 0, 0, 0],
        "unsupported_node",
        "unknown",
        MATH,
        "t",
        paragraph_id=formula_para["object_id"],
    )
    figure_para = xml_object(
        "/word/document.xml#0.1",
        [0, 1],
        "paragraph",
        "body",
        WORD,
        "p",
        text="Figure paragraph",
        para_id="22222222",
    )
    drawing = xml_object(
        "/word/document.xml#0.1.0",
        [0, 1, 0],
        "drawing",
        "body",
        WORD,
        "drawing",
        paragraph_id=figure_para["object_id"],
    )
    graphic = xml_object(
        "/word/document.xml#0.1.0.0",
        [0, 1, 0, 0],
        "unsupported_node",
        "unknown",
        DRAWING,
        "graphic",
        paragraph_id=figure_para["object_id"],
    )
    snapshot = {
        "objects": [formula_para, formula, formula_run, formula_text, figure_para, drawing, graphic]
    }
    findings = [
        finding(item["object_id"], item["path"], item["kind"], item["role"])
        for item in (formula, formula_run, formula_text, drawing, graphic)
    ]

    projected = view(snapshot, findings)
    groups = {group["category"]: group for group in projected.groups}

    assert set(groups) == {"formula", "figure"}
    assert groups["formula"]["counts"]["cannot_determine"] == 3
    assert groups["formula"]["location_count"] == 1
    assert groups["formula"]["object_number"] == 1
    assert groups["figure"]["counts"]["cannot_determine"] == 2
    assert groups["figure"]["location_count"] == 1
    assert groups["figure"]["object_number"] == 1
    formula_location = projected.locations_by_group[groups["formula"]["id"]][0]
    figure_location = projected.locations_by_group[groups["figure"]["id"]][0]
    assert (formula_location["para_id"], formula_location["label"]) == (
        "11111111",
        "Equation paragraph",
    )
    assert (figure_location["para_id"], figure_location["label"]) == (
        "22222222",
        "Figure paragraph",
    )


def test_table_conditions_separate_header_body_banding_and_exceptions():
    table_id = "/word/document.xml#0.10"
    header_context = {
        "table_object_id": table_id,
        "row_index": 0,
        "row_count": 2,
        "conditions": ["firstRow", "band1Horz"],
    }
    body_context = {
        "table_object_id": table_id,
        "row_index": 1,
        "row_count": 2,
        "conditions": ["band1Horz"],
    }
    banded_context = {
        "table_object_id": table_id,
        "row_index": 1,
        "row_count": 2,
        "column_index": 1,
        "column_count": 2,
        "conditions": ["band1Vert"],
    }
    exception_context = {
        "table_object_id": table_id,
        "row_index": 1,
        "row_count": 2,
        "column_index": 0,
        "column_count": 2,
        "conditions": ["firstCol", "band1Horz"],
    }
    table = xml_object(
        table_id,
        [0, 10],
        "table",
        "unknown",
        WORD,
        "tbl",
        properties={"table": {"alignment": "center"}},
    )
    header = xml_object(
        "/word/document.xml#0.10.0",
        [0, 10, 0],
        "tr",
        "unknown",
        WORD,
        "tr",
        table_context=header_context,
    )
    body = xml_object(
        "/word/document.xml#0.10.1",
        [0, 10, 1],
        "tr",
        "unknown",
        WORD,
        "tr",
        table_context=body_context,
    )
    banded = xml_object(
        "/word/document.xml#0.10.1.1",
        [0, 10, 1, 1],
        "tc",
        "unknown",
        WORD,
        "tc",
        table_context=banded_context,
    )
    exception = xml_object(
        "/word/document.xml#0.10.1.0",
        [0, 10, 1, 0],
        "tc",
        "unknown",
        WORD,
        "tc",
        table_context=exception_context,
    )
    snapshot = {"objects": [table, header, body, banded, exception]}
    findings = [
        finding(header["object_id"], header["path"], "tr", "unknown", "row.height"),
        finding(body["object_id"], body["path"], "tr", "unknown", "row.height"),
        finding(banded["object_id"], banded["path"], "tc", "unknown", "cell.widthTwips"),
        finding(exception["object_id"], exception["path"], "tc", "unknown", "cell.widthTwips"),
    ]

    projected = view(snapshot, findings)
    areas = {
        group.get("table_area", "whole"): group
        for group in projected.groups
        if group["category"] == "table"
    }

    assert set(areas) == {"header", "body", "exception"}
    assert areas["header"]["location_count"] == 1
    assert areas["body"]["location_count"] == 2
    assert areas["exception"]["location_count"] == 1
    assert all(group["object_number"] == 1 for group in areas.values())


def test_actions_use_exact_kerning_and_line_spacing_paths():
    snapshot = {"objects": []}
    findings = [
        finding("run-kerning", [0, 0], "run", "body", "run.kerningMinPt"),
        finding("run-spacing", [0, 1], "run", "body", "paragraph.lineSpacing.rule"),
        finding("run-spacing-value", [0, 2], "run", "body", "paragraph.lineSpacing.value"),
    ]

    projected = view(snapshot, findings)

    assert {(group["category"], group["action"]) for group in projected.groups} == {
        ("body", "kerning"),
        ("body", "line_spacing"),
    }


def test_row_page_flow_flags_group_as_page_flow_without_changing_row_layout():
    snapshot = {"objects": []}
    findings = [
        finding("row", [0, 0], "tr", "unknown", "row.cantSplit"),
        finding("row", [0, 0], "tr", "unknown", "row.isHeader"),
        finding("row", [0, 0], "tr", "unknown", "row.height"),
    ]

    projected = view(snapshot, findings)

    assert {group["action"] for group in projected.groups} == {"page_flow", "layout"}


def test_remaining_review_groups_preserve_each_unresolved_verdict_location():
    paragraphs = [
        xml_object(
            f"/word/document.xml#0.{index}",
            [0, index],
            "paragraph",
            "body",
            WORD,
            "p",
            para_id=f"0000000{index}",
        )
        for index in range(1, 4)
    ]
    findings = [
        finding(
            item["object_id"],
            item["path"],
            "paragraph",
            "body",
            property_path,
            verdict=verdict,
        )
        for item, property_path, verdict in zip(
            paragraphs,
            ("run.fontSizePt", "run.fontSizePt", "run.bold"),
            ("observed_difference", "cannot_determine", "observed_match"),
            strict=True,
        )
    ]
    projected = view({"objects": paragraphs}, findings)

    (remaining,) = remaining_review_groups(projected, findings)

    assert len(projected.groups) == 2
    assert remaining["action"] == "size"
    for item, para_id in zip(findings[:2], ("00000001", "00000002"), strict=True):
        example = remaining["examples"][item["verdict"]]
        assert example["case_id"] == item["case_id"]
        assert example["location"]["para_id"] == para_id


def test_coverage_and_other_run_findings_anchor_to_the_owning_paragraph():
    paragraph = xml_object(
        "/word/document.xml#0.0",
        [0, 0],
        "paragraph",
        "unknown",
        WORD,
        "p",
        text="Owned paragraph",
        para_id="11111111",
    )
    run = xml_object(
        "/word/document.xml#0.0.0",
        [0, 0, 0],
        "run",
        "unknown",
        WORD,
        "r",
        paragraph_id=paragraph["object_id"],
    )
    projected = view(
        {"objects": [paragraph, run]},
        [
            finding(run["object_id"], run["path"], "run", "unknown"),
            finding(run["object_id"], run["path"], "run", "unknown", "run.custom"),
        ],
    )

    locations = [
        location
        for group in projected.groups
        for location in projected.locations_by_group[group["id"]]
    ]
    assert len(locations) == 2
    assert {(item["label"], item["para_id"]) for item in locations} == {
        ("Owned paragraph", "11111111")
    }


def test_formula_and_figure_inside_a_table_keep_visual_identity_and_coordinates():
    table_id = "/word/document.xml#0.10"
    table_context = {
        "table_object_id": table_id,
        "row_index": 0,
        "row_count": 1,
        "column_index": 0,
        "column_count": 1,
        "conditions": ["firstRow"],
    }
    table = xml_object(
        table_id,
        [0, 10],
        "table",
        "unknown",
        WORD,
        "tbl",
    )
    row = xml_object(
        "/word/document.xml#0.10.0",
        [0, 10, 0],
        "tr",
        "unknown",
        WORD,
        "tr",
        table_context=table_context,
    )
    cell = xml_object(
        "/word/document.xml#0.10.0.0",
        [0, 10, 0, 0],
        "tc",
        "unknown",
        WORD,
        "tc",
        table_context=table_context,
    )
    paragraph = xml_object(
        "/word/document.xml#0.10.0.0.0",
        [0, 10, 0, 0, 0],
        "paragraph",
        "body",
        WORD,
        "p",
        text="Cell visual",
        para_id="22222222",
        table_context=table_context,
    )
    formula = xml_object(
        "/word/document.xml#0.10.0.0.0.0",
        [0, 10, 0, 0, 0, 0],
        "unsupported_node",
        "unknown",
        MATH,
        "oMath",
        paragraph_id=paragraph["object_id"],
        table_context=table_context,
    )
    formula_text = xml_object(
        "/word/document.xml#0.10.0.0.0.0.0",
        [0, 10, 0, 0, 0, 0, 0],
        "unsupported_node",
        "unknown",
        MATH,
        "t",
        paragraph_id=paragraph["object_id"],
        table_context=table_context,
    )
    figure = xml_object(
        "/word/document.xml#0.10.0.0.0.1",
        [0, 10, 0, 0, 0, 1],
        "drawing",
        "unknown",
        WORD,
        "drawing",
        paragraph_id=paragraph["object_id"],
        table_context=table_context,
    )
    figure_child = xml_object(
        "/word/document.xml#0.10.0.0.0.1.0",
        [0, 10, 0, 0, 0, 1, 0],
        "unsupported_node",
        "unknown",
        DRAWING,
        "graphic",
        paragraph_id=paragraph["object_id"],
        table_context=table_context,
    )
    projected = view(
        {"objects": [table, row, cell, paragraph, formula, formula_text, figure, figure_child]},
        [
            finding(item["object_id"], item["path"], item["kind"], item["role"])
            for item in (formula_text, figure_child)
        ],
    )

    groups = {group["category"]: group for group in projected.groups}
    assert set(groups) == {"formula", "figure"}
    assert all(group["location_count"] == 1 for group in groups.values())
    assert all(group["object_number"] == 1 for group in groups.values())
    for group in groups.values():
        location = projected.locations_by_group[group["id"]][0]
        assert (location["label"], location["para_id"]) == ("Cell visual", "22222222")
        assert (location["row"], location["column"]) == (1, 1)


def test_table_row_and_cell_locations_use_exact_first_addressable_paragraphs():
    adjacent = xml_object(
        "/word/document.xml#0.9",
        [0, 9],
        "paragraph",
        "body",
        WORD,
        "p",
        text="Adjacent paragraph",
        para_id="99999999",
    )
    table = xml_object(
        "/word/document.xml#0.10",
        [0, 10],
        "table",
        "unknown",
        WORD,
        "tbl",
    )
    row = xml_object(
        "/word/document.xml#0.10.0",
        [0, 10, 0],
        "tr",
        "unknown",
        WORD,
        "tr",
        table_context={"table_object_id": table["object_id"], "row_index": 0, "row_count": 1},
    )
    first_cell = xml_object(
        "/word/document.xml#0.10.0.0",
        [0, 10, 0, 0],
        "tc",
        "unknown",
        WORD,
        "tc",
        table_context={
            "table_object_id": table["object_id"],
            "row_index": 0,
            "row_count": 1,
            "column_index": 0,
            "column_count": 2,
        },
    )
    second_cell = xml_object(
        "/word/document.xml#0.10.0.1",
        [0, 10, 0, 1],
        "tc",
        "unknown",
        WORD,
        "tc",
        table_context={
            "table_object_id": table["object_id"],
            "row_index": 0,
            "row_count": 1,
            "column_index": 1,
            "column_count": 2,
        },
    )
    first_paragraph = xml_object(
        "/word/document.xml#0.10.0.0.0",
        [0, 10, 0, 0, 0],
        "paragraph",
        "body",
        WORD,
        "p",
        text="First cell paragraph",
        para_id="11111111",
    )
    second_paragraph = xml_object(
        "/word/document.xml#0.10.0.1.0",
        [0, 10, 0, 1, 0],
        "paragraph",
        "body",
        WORD,
        "p",
        text="Second cell paragraph",
        para_id="22222222",
    )
    snapshot = {
        "objects": [
            adjacent,
            table,
            row,
            first_cell,
            second_cell,
            first_paragraph,
            second_paragraph,
        ]
    }

    for target, expected in (
        (table, ("First cell paragraph", "11111111")),
        (row, ("First cell paragraph", "11111111")),
        (second_cell, ("Second cell paragraph", "22222222")),
    ):
        projected = view(
            snapshot,
            [finding(target["object_id"], target["path"], target["kind"], target["role"])],
        )
        location = projected.locations_by_group[projected.groups[0]["id"]][0]
        assert (location["label"], location["para_id"]) == expected


def test_table_and_row_without_retained_paragraphs_keep_raw_object_fallback():
    adjacent = xml_object(
        "/word/document.xml#0.19",
        [0, 19],
        "paragraph",
        "body",
        WORD,
        "p",
        text="Adjacent paragraph",
        para_id="99999999",
    )
    table = xml_object(
        "/word/document.xml#0.20",
        [0, 20],
        "table",
        "unknown",
        WORD,
        "tbl",
    )
    row = xml_object(
        "/word/document.xml#0.20.0",
        [0, 20, 0],
        "tr",
        "unknown",
        WORD,
        "tr",
        table_context={"table_object_id": table["object_id"], "row_index": 0, "row_count": 1},
    )
    snapshot = {"objects": [adjacent, table, row]}

    for target, expected_row in ((table, None), (row, 1)):
        projected = view(
            snapshot,
            [finding(target["object_id"], target["path"], target["kind"], target["role"])],
        )
        location = projected.locations_by_group[projected.groups[0]["id"]][0]
        assert "para_id" not in location
        assert location.get("row") == expected_row


def test_section_location_uses_membership_instead_of_the_nearest_paragraph():
    section_id = "/word/document.xml#0.5"
    section_region = {"section_object_id": section_id, "role": "body", "role_basis": []}
    before = xml_object(
        "/word/document.xml#0.4",
        [0, 4],
        "paragraph",
        "body",
        WORD,
        "p",
        text="Nearest but outside",
        para_id="44444444",
    )
    section = xml_object(
        section_id,
        [0, 5],
        "section",
        "unknown",
        WORD,
        "sectPr",
        region=section_region,
    )
    member = xml_object(
        "/word/document.xml#0.1",
        [0, 1],
        "paragraph",
        "body",
        WORD,
        "p",
        text="Section member",
        para_id="11111111",
        region=section_region,
    )

    projected = view(
        {"objects": [before, section, member]},
        [finding(section["object_id"], section["path"], section["kind"], section["role"])],
    )
    location = projected.locations_by_group[projected.groups[0]["id"]][0]

    assert (location["label"], location["para_id"]) == ("Section member", "11111111")


def test_line_spacing_rule_uses_the_same_retained_object_outside_the_detail_page():
    rule = finding(
        "/word/document.xml#0.0",
        [0, 0],
        "paragraph",
        "body",
        "paragraph.lineSpacing.rule",
        verdict="observed_difference",
        observed="exact",
        expected="auto",
    )
    value = finding(
        "/word/document.xml#0.0",
        [0, 0],
        "paragraph",
        "body",
        "paragraph.lineSpacing.value",
        verdict="cannot_determine",
        observed=None,
        expected=240,
    )

    projected = with_line_spacing_rules([value], [rule, value])

    assert projected[0]["line_spacing_rule"] == {"observed": "exact", "expected": "auto"}


def test_outline_basis_fallback_is_one_based():
    finding_value = finding(
        "heading-run",
        [0, 0, 0],
        "run",
        "heading",
        "run.fontSizePt",
        role_basis=[{"source": "outline_level", "value": "2", "certainty": "explicit"}],
    )

    projected = view({"objects": []}, [finding_value])

    assert projected.groups[0]["category"] == "heading"
    assert projected.groups[0]["heading_level"] == 3


def test_candidate_projection_keeps_non_main_part_and_marks_observed_difference():
    findings = [
        {
            **finding(
                "/word/header1.xml#0.0",
                [0, 0],
                "run",
                "body",
                "run.fontSizePt",
                verdict="observed_difference",
                observed=11,
                expected=12,
                expected_value_count=1,
                template_object_ids=["/word/styles.xml#0.0"],
                template_object_count=1,
            ),
            "part": "/word/header1.xml",
        },
        {
            **finding(
                "table-run",
                [0, 1],
                "run",
                "body",
                "run.fontSizePt",
                verdict="observed_difference",
                observed=11,
                expected=12,
                expected_value_count=1,
            ),
            "table_context": {"table_object_id": "table"},
        },
    ]

    result = candidate_findings_result(
        {
            "check_id": "check-focused",
            "baseline_id": "baseline-focused",
            "source_sha256": "a" * 64,
        },
        findings,
        property_paths=["run.fontSizePt"],
        offset=0,
        limit=100,
    )

    assert result["total"] == 1
    assert result["findings"][0]["part"] == "/word/header1.xml"
    assert result["findings"][0]["verdict"] == "observed_difference"
    assert result["findings"][0]["expected_value_count"] == 1
    assert "reason" not in result["findings"][0]


def test_verification_matches_final_object_ids_and_omits_non_scalar_observed():
    findings = [
        finding(
            "/word/document.xml#0.0",
            [0, 0],
            "run",
            "body",
            "run.fontSizePt",
            verdict="observed_match",
            observed=["ambiguous"],
            expected=["ambiguous"],
        ),
        finding(
            "/word/document.xml#0.1",
            [0, 1],
            "run",
            "body",
            "run.fontSizePt",
            verdict="observed_difference",
            observed=12,
            expected=14,
        ),
    ]
    check = {
        "check_id": "check-focused",
        "baseline_id": "baseline-focused",
        "source_sha256": "a" * 64,
    }

    result = finding_verification_result(
        check,
        findings,
        [
            {
                "case_id": findings[0]["case_id"],
                "property_path": findings[0]["property_path"],
                "object_ids": [],
            },
            {
                "case_id": "case-after-formatting",
                "property_path": findings[1]["property_path"],
                "object_ids": [findings[1]["object_id"], findings[1]["object_id"]],
            },
        ],
    )

    by_object = {item["object_id"]: item for item in result["findings"]}
    assert result["total"] == 2
    assert "observed" not in by_object["/word/document.xml#0.0"]
    assert by_object["/word/document.xml#0.1"]["observed"] == 12
