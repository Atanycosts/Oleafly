"""Independent examples for effective template/manuscript format comparison."""

import json

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.journals.template_compare import compare_template


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


def snapshot(*objects: JsonObject) -> JsonObject:
    return {"schema_version": 1, "objects": list(objects)}


def findings_for(findings: list[JsonObject], property_path: str) -> list[JsonObject]:
    return [finding for finding in findings if finding["property_path"] == property_path]


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
