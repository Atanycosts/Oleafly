"""Independent examples for effective template/manuscript format comparison."""

import json

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.journals.template_compare import compare_template
from research_file_workbench.journals.template_models import template_font_requirements


def object_fact(
    object_id: str,
    *,
    kind: str,
    role: str,
    properties: JsonObject,
    path: list[int] | None = None,
    text: str = "",
    style_id: str | None = None,
    evidence: JsonObject | None = None,
    role_basis: list[JsonObject] | None = None,
    table_context: JsonObject | None = None,
) -> JsonObject:
    result: JsonObject = {
        "object_id": object_id,
        "kind": kind,
        "role": role,
        "role_basis": role_basis or [],
        "part": "/word/document.xml",
        "path": path or [0],
        "properties": properties,
    }
    if text:
        result["text"] = text
    if style_id:
        result["style_id"] = style_id
    if evidence:
        result["evidence"] = evidence
    if table_context:
        result["table_context"] = table_context
    return result


def run_fact(
    object_id: str,
    role: str,
    *,
    size: int,
    path: list[int] | None = None,
    text: str = "",
    style_id: str | None = None,
    evidence: JsonObject | None = None,
    role_basis: list[JsonObject] | None = None,
    inline: JsonObject | None = None,
    table_context: JsonObject | None = None,
) -> JsonObject:
    run_properties: JsonObject = {"fontSizePt": size}
    if inline:
        run_properties.update(inline)
    return object_fact(
        object_id,
        kind="run",
        role=role,
        path=path,
        text=text,
        style_id=style_id,
        evidence=evidence,
        role_basis=role_basis,
        table_context=table_context,
        properties={
            "run": run_properties,
            "script_usage": {
                "latin": True,
                "east_asian": False,
                "complex": False,
                "other": False,
            },
        },
    )


def snapshot(*objects: JsonObject, unsupported: list[JsonObject] | None = None) -> JsonObject:
    result: JsonObject = {"schema_version": 1, "objects": list(objects)}
    if unsupported is not None:
        result["unsupported"] = unsupported
    return result


def unsupported_band_size(table_id: str) -> JsonObject:
    return {
        "code": "table_band_size_unsupported",
        "detail": "Table row or column band sizes other than one are not supported.",
        "object_ids": [table_id],
    }


def findings_for(findings: list[JsonObject], property_path: str) -> list[JsonObject]:
    return [finding for finding in findings if finding["property_path"] == property_path]


def table_context(
    table_id: str,
    row_index: int,
    row_count: int,
    *,
    column_index: int | None = None,
    column_count: int | None = None,
    conditions: list[str] | None = None,
) -> JsonObject:
    result: JsonObject = {
        "table_object_id": table_id,
        "row_index": row_index,
        "row_count": row_count,
        "conditions": conditions or [],
    }
    if column_index is not None:
        result["column_index"] = column_index
    if column_count is not None:
        result["column_count"] = column_count
    return result


def test_title_and_body_are_paired_by_role_instead_of_path_or_sample_text():
    title_basis = [{"source": "style_name", "value": "Title", "certainty": "explicit"}]
    body_basis = [{"source": "style_name", "value": "Body", "certainty": "explicit"}]
    template = snapshot(
        run_fact(
            "template-title",
            "document_title",
            size=14,
            path=[0, 1],
            text="Short title",
            role_basis=title_basis,
        ),
        run_fact(
            "template-body",
            "body",
            size=10,
            path=[0, 2],
            text="Template prose",
            role_basis=body_basis,
        ),
    )
    manuscript = snapshot(
        run_fact(
            "manuscript-title",
            "document_title",
            size=10,
            path=[0, 8, 1],
            text="A different manuscript title",
            role_basis=title_basis,
        ),
        run_fact(
            "manuscript-body",
            "body",
            size=10,
            path=[0, 9, 3],
            text="Different manuscript prose",
            role_basis=body_basis,
        ),
    )

    findings = compare_template(template, manuscript)

    assert [(finding["role"], finding["verdict"]) for finding in findings] == [
        ("document_title", "observed_difference"),
        ("body", "observed_match"),
    ]
    assert findings[0]["path"] == [0, 8, 1]
    assert findings[0]["template_object_ids"] == ["template-title"]
    assert findings[0]["template_object_count"] == 1
    assert findings[0]["role_basis"] == title_basis
    assert findings[0]["template_role_basis"] == title_basis
    assert findings[0]["case_id"].startswith("case-")
    assert compare_template(template, manuscript) == findings


def test_effective_values_match_across_style_inheritance_and_excluded_declared_fields():
    template_basis = [{"source": "style_name", "value": "Body", "certainty": "explicit"}]
    manuscript_basis = [{"source": "style_name", "value": "Body", "certainty": "inferred"}]
    template = snapshot(
        object_fact(
            "template-paragraph",
            kind="paragraph",
            role="body",
            style_id="TemplateStyle",
            role_basis=template_basis,
            properties={
                "paragraph": {
                    "styleId": "TemplateStyle",
                    "inheritedRunProperties": {"fontSizePt": 9},
                    "markRunProperties": {"fontSizePt": 15},
                    "props": [{"localName": "jc", "attributes": {"val": "center"}}],
                    "available": 240,
                    "tabStopsCacheToken": "template-layout-cache",
                    "alignment": "center",
                },
                "paragraph_mark": {"fontSizePt": 18},
                "run_properties": {"fontSizePt": 18},
            },
        )
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-paragraph",
            kind="paragraph",
            role="body",
            style_id="ManuscriptStyle",
            role_basis=manuscript_basis,
            path=[5, 7, 9],
            properties={
                "paragraph": {
                    "styleId": "ManuscriptStyle",
                    "inheritedRunProperties": {"fontSizePt": 7},
                    "markRunProperties": {"fontSizePt": 8},
                    "props": [{"localName": "jc", "attributes": {"val": "left"}}],
                    "available": 180,
                    "tabStopsCacheToken": "manuscript-layout-cache",
                    "alignment": "center",
                },
                "paragraph_mark": {"fontSizePt": 7},
                "run_properties": {"fontSizePt": 7},
            },
        )
    )

    findings = compare_template(template, manuscript)

    assert len(findings) == 1
    finding = findings[0]
    assert finding["case_id"].startswith("case-")
    assert finding["object_id"] == "manuscript-paragraph"
    assert finding["path"] == [5, 7, 9]
    assert finding["property_path"] == "paragraph.alignment"
    assert finding["observed"] == "center"
    assert finding["expected"] == "center"
    assert finding["expected_value_count"] == 1
    assert finding["template_object_ids"] == ["template-paragraph"]
    assert finding["template_object_count"] == 1
    assert finding["role_basis"] == manuscript_basis
    assert finding["template_role_basis"] == template_basis
    assert finding["verdict"] == "observed_match"


def test_meaningful_paragraph_layout_fields_stay_comparable():
    template = snapshot(
        object_fact(
            "template-paragraph",
            kind="paragraph",
            role="body",
            properties={
                "paragraph": {
                    "indent": {"left": 18},
                    "spacing": {"before": 6},
                    "alignment": "center",
                    "outlineLevel": 1,
                    "borders": {"top": {"style": "single", "sizePt": 0.5}},
                    "tabStops": {
                        "defaultIntervalPt": 36,
                        "stops": [{"positionPt": 72, "alignment": "left"}],
                    },
                }
            },
        )
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-paragraph",
            kind="paragraph",
            role="body",
            path=[7, 3],
            properties={
                "paragraph": {
                    "indent": {"left": 12},
                    "spacing": {"before": 0},
                    "alignment": "center",
                    "outlineLevel": 2,
                    "borders": {"top": {"style": "double", "sizePt": 0.5}},
                    "tabStops": {
                        "defaultIntervalPt": 36,
                        "stops": [{"positionPt": 90, "alignment": "left"}],
                    },
                }
            },
        )
    )

    findings = compare_template(template, manuscript)
    verdicts = {finding["property_path"]: finding["verdict"] for finding in findings}

    assert verdicts == {
        "paragraph.alignment": "observed_match",
        "paragraph.borders.top.sizePt": "observed_match",
        "paragraph.borders.top.style": "observed_difference",
        "paragraph.indent.left": "observed_difference",
        "paragraph.outlineLevel": "observed_difference",
        "paragraph.spacing.before": "observed_difference",
        "paragraph.tabStops.defaultIntervalPt": "observed_match",
        "paragraph.tabStops.stops": "observed_difference",
    }


def test_list_identity_and_counter_cache_are_ignored_while_formatting_is_compared():
    template = snapshot(
        object_fact(
            "template-list",
            kind="paragraph",
            role="body",
            properties={
                "paragraph": {
                    "listItem": {
                        "numId": "1",
                        "ilvl": 0,
                        "abstractNumId": "10",
                        "numFmt": "decimal",
                        "markerText": "1.",
                        "ordinal": 1,
                        "markerAlign": "left",
                        "suffix": "tab",
                        "indent": {"left": 18, "hanging": 9},
                        "markerStyle": {"fontSizePt": 11},
                        "picBullet": {
                            "relationshipId": "rId-template-bullet",
                            "width": 12,
                            "height": 12,
                            "authored": {
                                "picBulletId": "1",
                                "relationshipId": "rId-template-source",
                                "width": 10,
                                "height": 10,
                            },
                        },
                        "cacheToken": "template-list-cache",
                    }
                }
            },
        )
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-list",
            kind="paragraph",
            role="body",
            path=[9, 4],
            properties={
                "paragraph": {
                    "listItem": {
                        "numId": "27",
                        "ilvl": 0,
                        "abstractNumId": "41",
                        "numFmt": "bullet",
                        "markerText": "7.",
                        "ordinal": 7,
                        "markerAlign": "left",
                        "suffix": "tab",
                        "indent": {"left": 18, "hanging": 9},
                        "markerStyle": {"fontSizePt": 10},
                        "picBullet": {
                            "relationshipId": "rId-manuscript-bullet",
                            "width": 12,
                            "height": 12,
                            "authored": {
                                "picBulletId": "9",
                                "relationshipId": "rId-manuscript-source",
                                "width": 10,
                                "height": 10,
                            },
                        },
                        "cacheToken": "manuscript-list-cache",
                    }
                }
            },
        )
    )

    findings = compare_template(template, manuscript)
    verdicts = {finding["property_path"]: finding["verdict"] for finding in findings}

    assert verdicts == {
        "paragraph.listItem.ilvl": "observed_match",
        "paragraph.listItem.indent.hanging": "observed_match",
        "paragraph.listItem.indent.left": "observed_match",
        "paragraph.listItem.markerAlign": "observed_match",
        "paragraph.listItem.markerStyle.fontSizePt": "observed_difference",
        "paragraph.listItem.numFmt": "observed_difference",
        "paragraph.listItem.picBullet.authored.height": "observed_match",
        "paragraph.listItem.picBullet.authored.width": "observed_match",
        "paragraph.listItem.picBullet.height": "observed_match",
        "paragraph.listItem.picBullet.width": "observed_match",
        "paragraph.listItem.suffix": "observed_match",
    }


def test_run_font_slots_are_filtered_by_the_scripts_actually_used():
    template = snapshot(
        object_fact(
            "template-run",
            kind="run",
            role="body",
            text="Mixed Latin 中文",
            properties={
                "run": {
                    "fontFamily": "Template Latin",
                    "fontFamilyEastAsia": "Template CJK",
                    "fontSizePt": 12,
                },
                "script_usage": {
                    "latin": True,
                    "east_asian": True,
                    "complex": False,
                    "other": False,
                },
            },
        )
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-run",
            kind="run",
            role="body",
            text="只有中文",
            properties={
                "run": {
                    "fontFamily": "Unused Latin",
                    "fontFamilyEastAsia": "Template CJK",
                    "fontSizePt": 12,
                },
                "script_usage": {
                    "latin": False,
                    "east_asian": True,
                    "complex": False,
                    "other": False,
                },
            },
        )
    )

    findings = compare_template(template, manuscript)

    assert {finding["property_path"] for finding in findings} == {
        "run.fontFamilyEastAsia",
        "run.fontSizePt",
    }
    assert all(finding["verdict"] == "observed_match" for finding in findings)
    assert all(len(finding["template_object_ids"]) == 1 for finding in findings)


def test_heading_runs_use_their_paragraph_outline_level_without_cross_document_ids():
    template = snapshot(
        object_fact(
            "template-heading-paragraph",
            kind="paragraph",
            role="heading",
            properties={"paragraph": {"outlineLevel": 0}},
        ),
        run_fact(
            "template-heading-run",
            "heading",
            size=14,
            evidence={"paragraph_object_id": "template-heading-paragraph"},
        ),
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-heading-paragraph",
            kind="paragraph",
            role="heading",
            path=[20, 1],
            properties={"paragraph": {"outlineLevel": 1}},
        ),
        run_fact(
            "manuscript-heading-run",
            "heading",
            size=10,
            path=[20, 2],
            evidence={"paragraph_object_id": "manuscript-heading-paragraph"},
        ),
    )

    findings = compare_template(template, manuscript)
    assert all(item["verdict"] == "cannot_determine" for item in findings)
    assert all(item["reason"] == "No corresponding template profile" for item in findings)
    assert {item["object_id"] for item in findings} == {
        "manuscript-heading-paragraph",
        "manuscript-heading-run",
    }


def test_single_unknown_section_compares_columns_without_a_semantic_role():
    template = snapshot(
        object_fact(
            "template-section",
            kind="section",
            role="unknown",
            properties={
                "section": {
                    "columns": {"count": 1},
                    "margins": {"leftTwips": 1440, "rightTwips": 1440},
                }
            },
        )
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-section",
            kind="section",
            role="unknown",
            path=[8, 4],
            properties={
                "section": {
                    "columns": {"count": 2},
                    "margins": {"leftTwips": 1440, "rightTwips": 1440},
                }
            },
        )
    )

    findings = compare_template(template, manuscript)
    by_path = {finding["property_path"]: finding for finding in findings}

    assert by_path["section.columns.count"]["verdict"] == "observed_difference"
    assert by_path["section.columns.count"]["observed"] == 2
    assert by_path["section.columns.count"]["expected"] == 1
    assert by_path["section.columns.count"]["template_object_ids"] == ["template-section"]
    assert by_path["section.columns.count"]["template_object_count"] == 1
    assert by_path["section.margins.leftTwips"]["verdict"] == "observed_match"
    assert by_path["section.margins.rightTwips"]["verdict"] == "observed_match"


def test_mixed_sections_use_common_values_and_never_pair_by_document_path():
    template = snapshot(
        object_fact(
            "template-section-one-column",
            kind="section",
            role="unknown",
            path=[2, 1],
            properties={
                "section": {
                    "columns": {"count": 1},
                    "margins": {"leftTwips": 1440},
                }
            },
        ),
        object_fact(
            "template-section-two-column",
            kind="section",
            role="unknown",
            path=[2, 9],
            properties={
                "section": {
                    "columns": {"count": 2},
                    "margins": {"leftTwips": 1440},
                }
            },
        ),
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-section",
            kind="section",
            role="unknown",
            path=[2, 9],
            properties={
                "section": {
                    "columns": {"count": 1},
                    "margins": {"leftTwips": 1440},
                }
            },
        )
    )

    findings = compare_template(template, manuscript)
    by_path = {finding["property_path"]: finding for finding in findings}
    columns = by_path["section.columns.count"]

    assert columns["verdict"] == "cannot_determine"
    assert columns["expected"] == [1, 2]
    assert columns["template_object_ids"] == [
        "template-section-one-column",
        "template-section-two-column",
    ]
    assert columns["template_object_count"] == 2
    assert by_path["section.margins.leftTwips"]["verdict"] == "observed_match"
    assert by_path["section.margins.leftTwips"]["template_object_ids"] == [
        "template-section-one-column"
    ]
    assert by_path["section.margins.leftTwips"]["template_object_count"] == 2


def region_fact(identity, region_role, columns):
    return {
        **object_fact(
            identity,
            kind="section",
            role="unknown",
            properties={"section": {"columns": {"count": columns}}},
        ),
        "region": {
            "section_object_id": identity,
            "role": region_role,
            "role_basis": [{"source": "context", "value": region_role, "certainty": "inferred"}],
        },
    }


def test_section_regions_pair_semantics_despite_order_and_detect_swapped_columns():
    template = snapshot(
        region_fact("template-front", "front_matter", 1), region_fact("template-body", "body", 2)
    )
    correct = snapshot(
        region_fact("draft-body", "body", 2), region_fact("draft-front", "front_matter", 1)
    )
    matches = compare_template(template, correct)
    assert len(matches) == 2 and all(item["verdict"] == "observed_match" for item in matches)
    assert matches[0]["template_object_ids"] == ["template-body"]
    assert matches[0]["region"]["role"] == "body"
    swapped = snapshot(
        region_fact("draft-front", "front_matter", 2), region_fact("draft-body", "body", 1)
    )
    differences = compare_template(template, swapped)
    assert len(differences) == 2 and all(
        item["verdict"] == "observed_difference" for item in differences
    )
    assert [item["expected"] for item in differences] == [1, 2]


def test_mixed_or_unknown_single_section_does_not_false_match_one_template_region():
    template = snapshot(
        region_fact("template-front", "front_matter", 1), region_fact("template-body", "body", 2)
    )
    for region in ("mixed", "unknown"):
        findings = compare_template(template, snapshot(region_fact("draft-shared", region, 1)))
        assert len(findings) == 1 and findings[0]["verdict"] == "cannot_determine"
        assert findings[0]["expected"] == [1, 2]
    unmatched = compare_template(template, snapshot(region_fact("draft-appendix", "appendix", 1)))
    assert len(unmatched) == 1 and unmatched[0]["verdict"] == "cannot_determine"
    assert unmatched[0]["reason"] == "No corresponding template profile"


def test_same_role_paragraph_and_run_use_semantic_region_profiles():
    def regional(identity, region, kind, size):
        fact = object_fact(
            identity,
            kind=kind,
            role="body",
            properties={"paragraph" if kind == "paragraph" else "run": {"fontSizePt": size}},
        )
        fact["region"] = {"section_object_id": "own-section", "role": region, "role_basis": []}
        return fact

    for kind in ("paragraph", "run"):
        template = snapshot(
            regional("front", "front_matter", kind, 14), regional("body", "body", kind, 10)
        )
        findings = compare_template(template, snapshot(regional("new-body", "body", kind, 14)))
        assert len(findings) == 1 and findings[0]["verdict"] == "observed_difference"
        assert findings[0]["expected"] == 10 and findings[0]["template_object_ids"] == ["body"]


def test_variant_inline_formats_are_uncertain_while_stable_properties_still_compare():
    template_basis = [{"source": "style_name", "value": "Body", "certainty": "explicit"}]
    template = snapshot(
        run_fact(
            "template-body-a",
            "body",
            size=12,
            role_basis=template_basis,
            inline={"bold": False, "italic": False, "underline": {"variant": "none"}},
        ),
        run_fact(
            "template-body-b",
            "body",
            size=12,
            role_basis=template_basis,
            inline={"bold": True, "italic": False, "underline": {"variant": "single"}},
        ),
    )
    manuscript = snapshot(
        run_fact(
            "manuscript-body",
            "body",
            size=11,
            path=[1],
            role_basis=template_basis,
            inline={"bold": True, "italic": False, "underline": {"variant": "single"}},
        ),
    )

    findings = compare_template(template, manuscript)

    by_path = {finding["property_path"]: finding for finding in findings}
    assert by_path["run.fontSizePt"]["verdict"] == "observed_difference"
    assert by_path["run.italic"]["verdict"] == "observed_match"
    assert by_path["run.bold"]["expected"] == [False, True]
    assert by_path["run.bold"]["verdict"] == "cannot_determine"
    assert by_path["run.underline.variant"]["expected"] == ["none", "single"]
    assert by_path["run.underline.variant"]["verdict"] == "cannot_determine"


def test_equal_effective_properties_do_not_require_style_ids_or_paths_to_match():
    template = snapshot(
        run_fact(
            "template-run",
            "reference",
            size=9,
            path=[1, 2, 3],
            style_id="TemplateReference",
        )
    )
    manuscript = snapshot(
        run_fact(
            "manuscript-run",
            "reference",
            size=9,
            path=[90, 80, 70],
            style_id="ManuscriptReference",
        )
    )

    findings = compare_template(template, manuscript)

    assert len(findings) == 1
    assert findings[0]["path"] == [90, 80, 70]
    assert findings[0]["verdict"] == "observed_match"
    assert findings[0]["template_object_ids"] == ["template-run"]
    assert findings[0]["template_object_count"] == 1


def test_unknown_manuscript_roles_are_never_treated_as_body():
    template = snapshot(
        object_fact(
            "template-body",
            kind="paragraph",
            role="body",
            properties={"paragraph": {"alignment": "left"}},
        )
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-unknown",
            kind="paragraph",
            role="unknown",
            path=[4, 2],
            properties={"paragraph": {"alignment": "left"}},
        )
    )

    findings = compare_template(template, manuscript)
    assert len(findings) == 1
    finding = findings[0]
    assert finding["case_id"].startswith("case-")
    assert finding["object_id"] == "manuscript-unknown"
    assert finding["kind"] == "paragraph"
    assert finding["role"] == "unknown"
    assert finding["path"] == [4, 2]
    assert finding["property_path"] == ""
    assert finding["observed"] is None
    assert finding["expected"] is None
    assert finding["template_object_ids"] == []
    assert finding["role_basis"] == []
    assert finding["template_role_basis"] == []
    assert finding["verdict"] == "cannot_determine"


def test_caption_kinds_pair_without_comparing_text_and_table_structure_is_not_counted():
    template = snapshot(
        run_fact("template-figure", "caption", size=9, text="Figure 1. Example drawing"),
        run_fact("template-table-caption", "caption", size=8, text="Table 1. Example values"),
        object_fact(
            "template-table",
            kind="table",
            role="unknown",
            properties={
                "table": {"alignment": "center", "columnWidthsPt": [100, 100]},
            },
        ),
        object_fact(
            "template-row",
            kind="tr",
            role="unknown",
            properties={
                "row": {
                    "id": "template-row-node",
                    "isHeader": True,
                    "height": {"rule": "atLeast", "valuePt": 12},
                    "text": "Template example",
                }
            },
        ),
        object_fact(
            "template-cell",
            kind="tc",
            role="unknown",
            properties={
                "cell": {
                    "id": "template-cell-node",
                    "vAlign": "top",
                    "text": "Template example cell",
                }
            },
        ),
    )
    manuscript = snapshot(
        run_fact(
            "manuscript-figure",
            "caption",
            size=8,
            path=[11],
            text="Figure 12. A different manuscript drawing",
        ),
        run_fact(
            "manuscript-table-caption",
            "caption",
            size=8,
            path=[12],
            text="Table 8. Different manuscript values",
        ),
        object_fact(
            "manuscript-table",
            kind="table",
            role="unknown",
            path=[13],
            properties={
                "table": {"alignment": "center", "columnWidthsPt": [100, 100, 100]},
            },
        ),
        object_fact(
            "manuscript-row",
            kind="tr",
            role="unknown",
            path=[14],
            properties={
                "row": {
                    "id": "manuscript-row-node",
                    "isHeader": True,
                    "height": {"rule": "atLeast", "valuePt": 12},
                    "text": "Different example",
                }
            },
        ),
        object_fact(
            "manuscript-cell",
            kind="tc",
            role="unknown",
            path=[15],
            properties={
                "cell": {
                    "id": "manuscript-cell-node",
                    "vAlign": "top",
                    "text": "Different example cell",
                }
            },
        ),
    )

    findings = compare_template(template, manuscript)

    figure = findings_for(findings, "run.fontSizePt")[0]
    table_caption = findings_for(findings, "run.fontSizePt")[1]
    assert figure["object_id"] == "manuscript-figure"
    assert figure["verdict"] == "observed_difference"
    assert table_caption["object_id"] == "manuscript-table-caption"
    assert table_caption["verdict"] == "observed_match"
    assert [finding["property_path"] for finding in findings] == [
        "run.fontSizePt",
        "run.fontSizePt",
        "table.alignment",
        "row.height.rule",
        "row.height.valuePt",
        "row.isHeader",
        "cell.vAlign",
    ]
    assert all(finding["verdict"] == "observed_match" for finding in findings[1:])
    assert not any(finding["property_path"] == "" for finding in findings)


def test_thousands_of_body_runs_have_bounded_linear_findings_and_provenance():
    template_runs: list[JsonObject] = []
    manuscript_runs: list[JsonObject] = []
    for index in range(3000):
        template_runs.append(
            run_fact(
                f"template-body-{index}",
                "body",
                size=12,
                role_basis=[
                    {
                        "source": "content",
                        "value": f"Template example body {index}",
                        "certainty": "inferred",
                    }
                ],
            )
        )
        manuscript_runs.append(
            run_fact(
                f"manuscript-body-{index}",
                "body",
                size=11,
                role_basis=[
                    {
                        "source": "content",
                        "value": f"Manuscript example body {index}",
                        "certainty": "inferred",
                    }
                ],
            )
        )

    findings = compare_template(snapshot(*template_runs), snapshot(*manuscript_runs))
    encoded = json.dumps(findings, ensure_ascii=False, separators=(",", ":")).encode()

    assert len(findings) == 3000
    assert len({finding["case_id"] for finding in findings}) == 3000
    assert all(finding["template_object_count"] == 3000 for finding in findings)
    assert all(finding["expected_value_count"] == 1 for finding in findings)
    assert all(len(finding["template_object_ids"]) == 1 for finding in findings)
    assert all(len(finding["template_role_basis"]) == 1 for finding in findings)
    assert all(
        "value" not in basis for finding in findings for basis in finding["template_role_basis"]
    )
    assert len(encoded) < len(findings) * 4096


def table_objects(
    prefix: str,
    row_count: int,
    *,
    header_bold: bool,
    first_column_shading: str,
) -> list[JsonObject]:
    table_id = f"{prefix}-table"
    objects: list[JsonObject] = [
        object_fact(
            table_id,
            kind="table",
            role="table",
            path=[0, 0],
            properties={
                "table": {
                    "alignment": "center",
                    "columnWidthsPt": [120, 120],
                }
            },
        )
    ]
    for row_index in range(row_count):
        conditions = ["firstRow"] if row_index == 0 else []
        row_id = f"{prefix}-row-{row_index}"
        objects.append(
            object_fact(
                row_id,
                kind="tr",
                role="unknown",
                path=[0, 0, row_index],
                table_context=table_context(table_id, row_index, row_count),
                properties={"row": {"isHeader": row_index == 0}},
            )
        )
        for column_index in range(2):
            cell_conditions = list(conditions)
            if column_index == 0:
                cell_conditions.append("firstCol")
                if row_index == 0:
                    cell_conditions.append("nwCell")
            cell_id = f"{prefix}-cell-{row_index}-{column_index}"
            objects.append(
                object_fact(
                    cell_id,
                    kind="tc",
                    role="unknown",
                    path=[0, 0, row_index, column_index],
                    table_context=table_context(
                        table_id,
                        row_index,
                        row_count,
                        column_index=column_index,
                        column_count=2,
                        conditions=cell_conditions,
                    ),
                    properties={
                        "cell": {
                            "id": f"{prefix}-node-{row_index}-{column_index}",
                            "gridColumn": column_index,
                            "gridColumnId": f"{prefix}-grid-{column_index}",
                            "shading": first_column_shading if column_index == 0 else None,
                        },
                        "table_style": {
                            "paragraphPropertyNodes": [{"id": f"{prefix}-style-node-{row_index}"}],
                            "runProperties": [],
                        },
                    },
                )
            )
            paragraph_id = f"{prefix}-paragraph-{row_index}-{column_index}"
            objects.append(
                object_fact(
                    paragraph_id,
                    kind="paragraph",
                    role="body",
                    path=[0, 0, row_index, column_index, 0],
                    table_context=table_context(
                        table_id,
                        row_index,
                        row_count,
                        column_index=column_index,
                        column_count=2,
                        conditions=cell_conditions,
                    ),
                    properties={"paragraph": {"alignment": "center"}},
                )
            )
            objects.append(
                run_fact(
                    f"{prefix}-run-{row_index}-{column_index}",
                    "body",
                    size=10,
                    path=[0, 0, row_index, column_index, 0, 0],
                    evidence={"paragraph_object_id": paragraph_id},
                    table_context=table_context(
                        table_id,
                        row_index,
                        row_count,
                        column_index=column_index,
                        column_count=2,
                        conditions=cell_conditions,
                    ),
                    inline={"bold": header_bold if row_index == 0 else False},
                )
            )
    return objects


def test_conditional_table_profiles_distinguish_correct_and_wrong_header_formatting():
    template = snapshot(
        *table_objects(
            "template",
            3,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    correct = compare_template(
        template,
        snapshot(
            *table_objects(
                "correct",
                3,
                header_bold=True,
                first_column_shading="E2F0D9",
            )
        ),
    )
    header_correct = [
        finding
        for finding in findings_for(correct, "run.bold")
        if finding["object_id"] == "correct-run-0-0"
    ][0]
    assert header_correct["verdict"] == "observed_match"
    assert set(header_correct["table_context"]["conditions"]) == {
        "firstCol",
        "firstRow",
        "nwCell",
    }

    wrong = compare_template(
        template,
        snapshot(
            *table_objects(
                "wrong",
                3,
                header_bold=False,
                first_column_shading="E2F0D9",
            )
        ),
    )
    header_wrong = [
        finding
        for finding in findings_for(wrong, "run.bold")
        if finding["object_id"] == "wrong-run-0-0"
    ][0]
    assert header_wrong["observed"] is False
    assert header_wrong["expected"] is True
    assert header_wrong["verdict"] == "observed_difference"
    data_findings = [
        finding
        for finding in findings_for(wrong, "run.bold")
        if finding["object_id"].startswith("wrong-run-1-")
    ]
    assert data_findings
    assert all(finding["verdict"] == "observed_match" for finding in data_findings)


def test_conditional_table_profiles_distinguish_correct_and_wrong_first_column_shading():
    template = snapshot(
        *table_objects(
            "template",
            2,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    correct = compare_template(
        template,
        snapshot(
            *table_objects(
                "correct",
                2,
                header_bold=True,
                first_column_shading="E2F0D9",
            )
        ),
    )
    first_column = [
        finding
        for finding in findings_for(correct, "cell.shading")
        if finding["object_id"].endswith("-cell-1-0")
    ][0]
    other_column = [
        finding
        for finding in findings_for(correct, "cell.shading")
        if finding["object_id"].endswith("-cell-1-1")
    ][0]
    assert first_column["verdict"] == "observed_match"
    assert other_column["verdict"] == "observed_match"

    wrong = compare_template(
        template,
        snapshot(
            *table_objects(
                "wrong",
                2,
                header_bold=True,
                first_column_shading="FFFFFF",
            )
        ),
    )
    first_column_wrong = [
        finding
        for finding in findings_for(wrong, "cell.shading")
        if finding["object_id"].endswith("-cell-1-0")
    ][0]
    assert first_column_wrong["observed"] == "FFFFFF"
    assert first_column_wrong["expected"] == "E2F0D9"
    assert first_column_wrong["verdict"] == "observed_difference"
    assert "firstCol" in first_column_wrong["table_context"]["conditions"]


def test_table_conditional_profiles_apply_by_position_not_absolute_row_count():
    template = snapshot(
        *table_objects(
            "template",
            3,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    manuscript = snapshot(
        *table_objects(
            "longer",
            5,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    findings = compare_template(template, manuscript)
    header = [
        finding
        for finding in findings_for(findings, "run.bold")
        if finding["object_id"] == "longer-run-0-0"
    ][0]
    last_data_row = [
        finding
        for finding in findings_for(findings, "run.bold")
        if finding["object_id"] == "longer-run-4-0"
    ][0]
    assert header["verdict"] == "observed_match"
    assert last_data_row["verdict"] == "observed_match"
    assert header["template_object_ids"] == ["template-run-0-0"]


def test_table_object_properties_are_compared_without_row_context():
    template_objects = table_objects(
        "template",
        1,
        header_bold=True,
        first_column_shading="E2F0D9",
    )
    manuscript_objects = table_objects(
        "manuscript",
        1,
        header_bold=True,
        first_column_shading="E2F0D9",
    )
    manuscript_table = manuscript_objects[0]
    manuscript_table["properties"] = {
        "table": {
            **manuscript_table["properties"]["table"],
            "alignment": "left",
        }
    }
    findings = compare_template(snapshot(*template_objects), snapshot(*manuscript_objects))
    alignment = [
        finding
        for finding in findings_for(findings, "table.alignment")
        if finding["object_id"] == "manuscript-table"
    ][0]
    assert alignment["observed"] == "left"
    assert alignment["expected"] == "center"
    assert alignment["verdict"] == "observed_difference"


def test_manuscript_band_size_unsupported_only_degrades_affected_table_children():
    template = snapshot(
        *table_objects(
            "template",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    manuscript = snapshot(
        *table_objects(
            "manuscript",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        ),
        unsupported=[unsupported_band_size("manuscript-table")],
    )
    findings = compare_template(template, manuscript)

    table_findings = [finding for finding in findings if finding["object_id"] == "manuscript-table"]
    child_findings = [
        finding
        for finding in findings
        if finding["object_id"] != "manuscript-table"
        and finding["kind"] in {"tr", "tc", "paragraph", "run"}
    ]
    assert table_findings
    assert all(finding["verdict"] == "observed_match" for finding in table_findings)
    assert all("reason" not in finding for finding in table_findings)
    assert child_findings
    assert all(finding["verdict"] == "cannot_determine" for finding in child_findings)
    assert all(
        finding["reason"] == "Table row or column band sizes other than one are not supported"
        for finding in child_findings
    )


def test_unsupported_template_candidate_is_not_filtered_from_a_shared_scope():
    template = snapshot(
        *table_objects(
            "supported-template",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        ),
        *table_objects(
            "unsupported-template",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        ),
        unsupported=[unsupported_band_size("unsupported-template-table")],
    )
    manuscript = snapshot(
        *table_objects(
            "manuscript",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    findings = compare_template(template, manuscript)

    header = [
        finding
        for finding in findings_for(findings, "run.bold")
        if finding["object_id"] == "manuscript-run-0-0"
    ][0]
    assert header["template_object_count"] == 2
    assert header["expected"] is True
    assert header["verdict"] == "cannot_determine"
    assert header["reason"] == "Table row or column band sizes other than one are not supported"


def test_unsupported_manuscript_table_does_not_degrade_an_unrelated_table():
    template = snapshot(
        *table_objects(
            "template",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    manuscript = snapshot(
        *table_objects(
            "affected",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        ),
        *table_objects(
            "unrelated",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        ),
        unsupported=[unsupported_band_size("affected-table")],
    )
    findings = compare_template(template, manuscript)

    affected = [
        finding
        for finding in findings_for(findings, "run.bold")
        if finding["object_id"] == "affected-run-0-0"
    ][0]
    unrelated = [
        finding
        for finding in findings_for(findings, "run.bold")
        if finding["object_id"] == "unrelated-run-0-0"
    ][0]
    assert affected["verdict"] == "cannot_determine"
    assert unrelated["verdict"] == "observed_match"
    assert "reason" not in unrelated


def test_unsupported_nested_table_does_not_degrade_its_outer_table():
    template = snapshot(
        *table_objects(
            "template-outer",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        ),
        *table_objects(
            "template-inner",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        ),
    )
    manuscript = snapshot(
        *table_objects(
            "manuscript-outer",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        ),
        *table_objects(
            "manuscript-inner",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        ),
        unsupported=[unsupported_band_size("manuscript-inner-table")],
    )
    findings = compare_template(template, manuscript)

    outer = [
        finding
        for finding in findings_for(findings, "run.bold")
        if finding["object_id"] == "manuscript-outer-run-0-0"
    ][0]
    inner = [
        finding
        for finding in findings_for(findings, "run.bold")
        if finding["object_id"] == "manuscript-inner-run-0-0"
    ][0]
    assert outer["verdict"] == "observed_match"
    assert inner["verdict"] == "cannot_determine"
    assert inner["reason"] == "Table row or column band sizes other than one are not supported"


def test_table_object_is_compared_without_table_context_children():
    template = snapshot(
        object_fact(
            "template-table",
            kind="table",
            role="table",
            properties={"table": {"alignment": "center"}},
        )
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-table",
            kind="table",
            role="table",
            properties={"table": {"alignment": "left"}},
        )
    )
    findings = compare_template(template, manuscript)
    assert len(findings) == 1
    assert findings[0]["property_path"] == "table.alignment"
    assert findings[0]["verdict"] == "observed_difference"


def test_template_table_order_never_selects_a_profile():
    first = table_objects(
        "first-template",
        2,
        header_bold=True,
        first_column_shading="E2F0D9",
    )
    second = table_objects(
        "second-template",
        2,
        header_bold=False,
        first_column_shading="FFFFFF",
    )
    manuscript = snapshot(
        *table_objects(
            "manuscript",
            2,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    forward = compare_template(snapshot(*first, *second), manuscript)
    reverse = compare_template(snapshot(*second, *first), manuscript)
    assert forward == reverse
    header = [
        finding
        for finding in findings_for(forward, "run.bold")
        if finding["object_id"] == "manuscript-run-0-0"
    ][0]
    assert header["expected"] == [False, True]
    assert header["verdict"] == "cannot_determine"


def test_paragraph_frame_presence_is_explicit_when_manuscript_adds_a_frame():
    template = snapshot(
        object_fact(
            "template-paragraph",
            kind="paragraph",
            role="body",
            properties={"paragraph": {"frame": None}},
        )
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-paragraph",
            kind="paragraph",
            role="body",
            properties={
                "paragraph": {
                    "frame": {
                        "widthPt": 120,
                        "hAnchor": "page",
                    }
                }
            },
        )
    )
    findings = compare_template(template, manuscript)
    assert len(findings) == 1
    assert findings[0]["property_path"] == "paragraph.frame.present"
    assert findings[0]["observed"] is True
    assert findings[0]["expected"] is False
    assert findings[0]["verdict"] == "observed_difference"


def test_paragraph_frame_presence_is_explicit_when_manuscript_removes_a_frame():
    template = snapshot(
        object_fact(
            "template-paragraph",
            kind="paragraph",
            role="body",
            properties={
                "paragraph": {
                    "frame": {
                        "widthPt": 120,
                        "heightPt": 40,
                        "hAnchor": "page",
                    }
                }
            },
        )
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-paragraph",
            kind="paragraph",
            role="body",
            properties={"paragraph": {"frame": None}},
        )
    )
    findings = compare_template(template, manuscript)
    assert len(findings) == 1
    assert findings[0]["property_path"] == "paragraph.frame.present"
    assert findings[0]["observed"] is False
    assert findings[0]["expected"] is True
    assert findings[0]["verdict"] == "observed_difference"


def test_reader_frame_presence_is_canonicalized_without_a_duplicate_finding():
    template = snapshot(
        object_fact(
            "template-paragraph",
            kind="paragraph",
            role="body",
            properties={"paragraph": {"framePresent": False, "frame": None}},
        )
    )
    manuscript = snapshot(
        object_fact(
            "manuscript-paragraph",
            kind="paragraph",
            role="body",
            properties={
                "paragraph": {
                    "framePresent": True,
                    "frame": {
                        "widthPt": 120,
                        "hAnchor": "page",
                    },
                }
            },
        )
    )
    findings = compare_template(template, manuscript)
    assert [finding["property_path"] for finding in findings] == ["paragraph.frame.present"]
    assert findings[0]["observed"] is True
    assert findings[0]["expected"] is False
    assert findings[0]["verdict"] == "observed_difference"


def test_table_body_instances_do_not_block_uninstantiated_body_style_fallback():
    template = snapshot(
        *table_objects(
            "template",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    template["style_definitions"] = [
        {
            **style_definition(role="body", size=13, outline=None, style_id="BodyText"),
            "name": "Body Text",
        }
    ]
    template["method_version"] = "docx-core-format-snapshot-1.1.0"
    correct_manuscript = snapshot(run_fact("manuscript-body", "body", size=13))
    correct_manuscript["method_version"] = "docx-core-format-snapshot-1.1.0"
    correct = compare_template(template, correct_manuscript)
    correct_size = findings_for(correct, "run.fontSizePt")[0]
    assert correct_size["verdict"] == "observed_match"
    assert correct_size["template_object_ids"] == ["/word/styles.xml#0.2.1.0"]

    wrong_manuscript = snapshot(run_fact("manuscript-body", "body", size=17))
    wrong_manuscript["method_version"] = "docx-core-format-snapshot-1.1.0"
    wrong = compare_template(template, wrong_manuscript)
    wrong_size = findings_for(wrong, "run.fontSizePt")[0]
    assert wrong_size["observed"] == 17
    assert wrong_size["expected"] == 13
    assert wrong_size["verdict"] == "observed_difference"
    assert wrong_size["template_object_ids"] == ["/word/styles.xml#0.2.1.0"]


def test_table_runs_never_pair_with_external_body_runs():
    external_template = run_fact("template-external", "body", size=18, inline={"bold": True})
    table_template = snapshot(
        *table_objects(
            "template",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    table_manuscript = snapshot(
        *table_objects(
            "manuscript",
            1,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    manuscript = snapshot(
        run_fact("manuscript-external", "body", size=18, inline={"bold": True}),
        *table_manuscript["objects"],
    )
    without_external = compare_template(table_template, table_manuscript)
    with_external = compare_template(snapshot(external_template), manuscript)
    assert any(finding["verdict"] == "observed_difference" for finding in with_external)
    external_findings = [
        finding for finding in with_external if finding["object_id"] == "manuscript-external"
    ]
    assert external_findings
    assert all(
        finding["template_object_ids"] == ["template-external"] for finding in external_findings
    )
    assert {finding["object_id"] for finding in without_external} == {
        finding["object_id"]
        for finding in with_external
        if finding["object_id"] != "manuscript-external"
    }


def style_definition(
    *,
    role: str,
    size: int,
    outline: int | None,
    style_id: str = "Heading3",
) -> JsonObject:
    return {
        "object_id": "/word/styles.xml#0.2.1.0",
        "part": "/word/styles.xml",
        "path": [0, 2, 1, 0],
        "style_id": style_id,
        "name": "heading 3",
        "type": "paragraph",
        "based_on": "Normal",
        "role": role,
        "role_basis": [
            {
                "source": "style_name",
                "value": "heading 3",
                "certainty": "inferred",
            }
        ],
        "properties": {
            "paragraph": {"outlineLevel": outline},
            "run": {"fontSizePt": size},
            "script_usage": {
                "latin": True,
                "east_asian": True,
                "complex": True,
                "other": True,
            },
        },
    }


def heading_manuscript(size: int, *, prefix: str = "manuscript") -> JsonObject:
    paragraph_id = f"{prefix}-paragraph"
    return snapshot(
        object_fact(
            paragraph_id,
            kind="paragraph",
            role="heading",
            properties={"paragraph": {"outlineLevel": 2}},
        ),
        run_fact(
            f"{prefix}-run",
            "heading",
            size=size,
            evidence={"paragraph_object_id": paragraph_id},
        ),
    )


def test_uninstantiated_heading_style_definition_supports_match_and_difference():
    template = snapshot(
        run_fact("template-h1", "heading", size=12),
    )
    template["style_definitions"] = [style_definition(role="heading", size=13, outline=2)]
    correct = compare_template(template, heading_manuscript(13))
    correct_run = [
        finding
        for finding in findings_for(correct, "run.fontSizePt")
        if finding["object_id"] == "manuscript-run"
    ][0]
    assert correct_run["verdict"] == "observed_match"
    assert correct_run["template_object_ids"] == ["/word/styles.xml#0.2.1.0"]

    wrong = compare_template(template, heading_manuscript(19))
    wrong_run = [
        finding
        for finding in findings_for(wrong, "run.fontSizePt")
        if finding["object_id"] == "manuscript-run"
    ][0]
    assert wrong_run["observed"] == 19
    assert wrong_run["expected"] == 13
    assert wrong_run["verdict"] == "observed_difference"


def test_template_instance_takes_priority_over_style_definition():
    template = snapshot(
        object_fact(
            "template-heading-paragraph",
            kind="paragraph",
            role="heading",
            properties={"paragraph": {"outlineLevel": 2}},
        ),
        run_fact(
            "template-heading-run",
            "heading",
            size=15,
            evidence={"paragraph_object_id": "template-heading-paragraph"},
        ),
    )
    template["style_definitions"] = [style_definition(role="heading", size=13, outline=2)]
    findings = compare_template(template, heading_manuscript(15))
    run_finding = [
        finding
        for finding in findings_for(findings, "run.fontSizePt")
        if finding["object_id"] == "manuscript-run"
    ][0]
    assert run_finding["verdict"] == "observed_match"
    assert run_finding["template_object_ids"] == ["template-heading-run"]


def test_unknown_style_definitions_are_not_used_as_generic_profiles():
    template = snapshot(run_fact("template-h1", "heading", size=12))
    template["style_definitions"] = [style_definition(role="unknown", size=13, outline=None)]
    findings = compare_template(template, heading_manuscript(13))
    run_findings = [finding for finding in findings if finding["object_id"] == "manuscript-run"]
    assert len(run_findings) == 1
    assert run_findings[0]["reason"] == "No corresponding template profile"


def test_font_preparation_includes_style_fonts_used_by_heading_comparison():
    template = snapshot()
    definition = style_definition(role="heading", size=13, outline=2)
    definition["properties"]["run"].update(
        fontFamily="Heading Latin Exact",
        fontFamilyEastAsia="Heading CJK Exact",
        complexLane={"fontFamily": "Heading Arabic Exact"},
    )
    template["style_definitions"] = [definition]
    manuscript = heading_manuscript(13)
    manuscript["objects"][1]["properties"]["script_usage"] = {
        "latin": True,
        "east_asian": True,
        "complex": True,
        "other": True,
    }
    findings = compare_template(template, manuscript)
    assert findings_for(findings, "run.fontFamily")[0]["expected"] == "Heading Latin Exact"
    assert findings_for(findings, "run.fontFamilyEastAsia")[0]["expected"] == "Heading CJK Exact"
    assert (
        findings_for(findings, "run.complexLane.fontFamily")[0]["expected"]
        == "Heading Arabic Exact"
    )
    assert template_font_requirements(template) == [
        {"family": "Heading Arabic Exact", "roles": ["heading"], "scripts": ["complex"]},
        {"family": "Heading CJK Exact", "roles": ["heading"], "scripts": ["east_asian"]},
        {"family": "Heading Latin Exact", "roles": ["heading"], "scripts": ["latin", "other"]},
    ]


def test_font_preparation_preserves_instance_priority_and_excludes_unused_style_lanes():
    template = heading_manuscript(15, prefix="template")
    template["objects"][1]["text"] = "Heading"
    template["objects"][1]["properties"]["run"]["fontFamily"] = "Instance Exact"
    overridden = style_definition(role="heading", size=13, outline=2)
    overridden["properties"]["run"]["fontFamily"] = "Overridden Font"
    unknown = style_definition(role="unknown", size=13, outline=None)
    unknown["properties"]["run"]["fontFamily"] = "Unknown Font"
    character = style_definition(role="body", size=13, outline=None)
    character["type"] = "character"
    character["properties"]["run"]["fontFamily"] = "Character Font"
    fallback = style_definition(role="body", size=13, outline=None)
    fallback["properties"]["script_usage"] = {"east_asian": True}
    fallback["properties"]["run"].update(
        fontFamily="Inactive Latin Font",
        fontFamilyEastAsia="Body CJK Exact",
        complexLane={"fontFamily": "Inactive Arabic Font"},
    )
    unpaired_heading = style_definition(role="heading", size=13, outline=None)
    unpaired_heading["properties"]["run"]["fontFamily"] = "Unpaired Heading Font"
    template["style_definitions"] = [overridden, unknown, character, fallback, unpaired_heading]
    manuscript = heading_manuscript(15)
    body = run_fact("manuscript-body", "body", size=13)
    body["properties"]["script_usage"] = {"east_asian": True}
    manuscript["objects"].append(body)
    findings = compare_template(template, manuscript)
    assert findings_for(findings, "run.fontFamily")[0]["expected"] == "Instance Exact"
    assert findings_for(findings, "run.fontFamilyEastAsia")[0]["expected"] == "Body CJK Exact"
    assert template_font_requirements(template) == [
        {"family": "Body CJK Exact", "roles": ["body"], "scripts": ["east_asian"]},
        {"family": "Instance Exact", "roles": ["heading"], "scripts": ["latin"]},
    ]


def test_internal_table_nodes_cache_and_raw_style_fields_never_create_findings():
    template_objects = table_objects(
        "template",
        1,
        header_bold=True,
        first_column_shading="E2F0D9",
    )
    manuscript_objects = table_objects(
        "manuscript",
        1,
        header_bold=True,
        first_column_shading="E2F0D9",
    )
    for obj in template_objects + manuscript_objects:
        properties = obj["properties"]
        if obj["kind"] == "paragraph":
            properties["paragraph"]["tabStopsCacheToken"] = f"{obj['object_id']}-cache"
        if obj["kind"] == "run":
            properties["run"]["cacheToken"] = f"{obj['object_id']}-cache"
        if obj["kind"] == "tc":
            properties["cell"]["gridColumnId"] = f"{obj['object_id']}-grid"
    findings = compare_template(snapshot(*template_objects), snapshot(*manuscript_objects))
    assert not any(
        finding["property_path"].endswith(
            ("cacheToken", "gridColumnId", "paragraphPropertyNodes", "id")
        )
        or finding["property_path"].startswith("table_style.")
        for finding in findings
    )


def test_old_snapshots_without_table_context_keep_legacy_table_behavior():
    template = snapshot(
        run_fact("template-table-run", "body", size=12, inline={"bold": True}),
    )
    manuscript = snapshot(
        run_fact("manuscript-table-run", "body", size=10, inline={"bold": False}),
    )
    template["method_version"] = "docx-core-format-snapshot-1.0.0"
    manuscript["method_version"] = "docx-core-format-snapshot-1.0.0"
    findings = compare_template(template, manuscript)
    by_path = {finding["property_path"]: finding for finding in findings}
    assert by_path["run.fontSizePt"]["verdict"] == "observed_difference"
    assert by_path["run.bold"]["verdict"] == "observed_difference"
    assert all("table_context" not in finding for finding in findings)


def test_missing_table_context_never_claims_conditional_coverage():
    template_objects = table_objects(
        "template",
        1,
        header_bold=True,
        first_column_shading="E2F0D9",
    )
    manuscript_objects = table_objects(
        "manuscript",
        1,
        header_bold=True,
        first_column_shading="E2F0D9",
    )
    for obj in manuscript_objects:
        obj.pop("table_context", None)
    template = snapshot(*template_objects)
    template["method_version"] = "docx-core-format-snapshot-1.1.0"
    manuscript = snapshot(*manuscript_objects)
    manuscript["method_version"] = "docx-core-format-snapshot-1.1.0"
    findings = compare_template(template, manuscript)
    table_findings = [finding for finding in findings if finding["kind"] in {"tr", "tc", "run"}]
    assert table_findings
    assert all(finding["verdict"] == "cannot_determine" for finding in table_findings)
    assert all(
        finding["reason"] == "No corresponding template profile" for finding in table_findings
    )


def test_same_table_style_with_different_row_style_ids_does_not_cross_pair():
    template_objects = table_objects(
        "template",
        2,
        header_bold=True,
        first_column_shading="E2F0D9",
    )
    manuscript_objects = table_objects(
        "manuscript",
        2,
        header_bold=False,
        first_column_shading="E2F0D9",
    )
    for obj in template_objects:
        if obj["kind"] == "paragraph":
            obj["style_id"] = "TemplateRowStyle"
    for obj in manuscript_objects:
        if obj["kind"] == "paragraph":
            obj["style_id"] = "ManuscriptRowStyle"
    findings = compare_template(snapshot(*template_objects), snapshot(*manuscript_objects))
    header = [
        finding
        for finding in findings_for(findings, "run.bold")
        if finding["object_id"] == "manuscript-run-0-0"
    ][0]
    data = [
        finding
        for finding in findings_for(findings, "run.bold")
        if finding["object_id"] == "manuscript-run-1-0"
    ][0]
    assert header["template_object_ids"] == ["template-run-0-0"]
    assert header["verdict"] == "observed_difference"
    assert data["template_object_ids"] == ["template-run-1-0"]
    assert data["verdict"] == "observed_match"


def test_incompatible_conditional_table_profiles_remain_undetermined():
    first = table_objects(
        "first-template",
        2,
        header_bold=True,
        first_column_shading="E2F0D9",
    )
    second = table_objects(
        "second-template",
        2,
        header_bold=False,
        first_column_shading="FFFFFF",
    )
    manuscript = snapshot(
        *table_objects(
            "manuscript",
            2,
            header_bold=True,
            first_column_shading="E2F0D9",
        )
    )
    findings = compare_template(snapshot(*first, *second), manuscript)
    header = [
        finding
        for finding in findings_for(findings, "run.bold")
        if finding["object_id"] == "manuscript-run-0-0"
    ][0]
    first_column = [
        finding
        for finding in findings_for(findings, "cell.shading")
        if finding["object_id"] == "manuscript-cell-1-0"
    ][0]
    assert header["expected"] == [False, True]
    assert header["verdict"] == "cannot_determine"
    assert first_column["expected"] == ["E2F0D9", "FFFFFF"]
    assert first_column["verdict"] == "cannot_determine"
