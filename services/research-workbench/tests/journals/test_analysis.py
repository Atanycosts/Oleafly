"""Independent examples for conservative journal-world source analysis."""

from io import BytesIO
from zipfile import ZipFile

import pymupdf
import pytest

from research_file_workbench.journals.analysis import analyze_world
from research_file_workbench.journals.models import (
    ANALYZER_VERSION,
    SourceInput,
    WorldAnalysisError,
)
from tests.journals.test_pdf_analysis import build_pdf

WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def template_bytes(sections=((11906, 16838, 1440, 1),)):
    body = []
    for width, height, margin, columns in sections:
        margins = (
            ""
            if margin is None
            else (
                f'<w:pgMar w:top="{margin}" w:right="{margin}" '
                f'w:bottom="{margin}" w:left="{margin}"/>'
            )
        )
        cols = "" if columns is None else f'<w:cols w:num="{columns}"/>'
        body.append(
            "<w:p><w:pPr><w:sectPr>"
            f'<w:pgSz w:w="{width}" w:h="{height}"/>{margins}{cols}'
            "</w:sectPr></w:pPr></w:p>"
        )
    return docx_bytes("".join(body))


def docx_bytes(body):
    stream = BytesIO()
    with ZipFile(stream, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/></Types>',
        )
        archive.writestr(
            "word/document.xml",
            f'<w:document xmlns:w="{WORD}"><w:body>{body}</w:body></w:document>',
        )
    return stream.getvalue()


def rules(world):
    return {rule["property"]: rule for rule in world["rules"]}


@pytest.mark.parametrize(
    "text, family",
    [
        ("All manuscript body text must use Times New Roman font.", "Times New Roman"),
        ("Body text must use PT Serif font.", "PT Serif"),
        ("Body text must use Latin Modern Roman font.", "Latin Modern Roman"),
        ("Body text must use Old English Text MT font.", "Old English Text MT"),
        ("Body text must use Noto Sans CJK SC font.", "Noto Sans CJK SC"),
        ("正文必须使用宋体字体。", "宋体"),
        ("正文字体必须为黑体。", "黑体"),
    ],
)
def test_body_font_requirement_preserves_exact_family_and_source(text, family):
    world = analyze_world(
        "journal-test", "Test", [SourceInput("guide.txt", "guide_text", text.encode())]
    )
    rule = rules(world)["body_font_family"]
    assert rule["expected"] == family
    assert rule["unit"] == "font_family"
    assert rule["basis_status"] == "confirmed"
    assert rule["evidence"][0]["quote"] == text
    assert rule["evidence"][0]["locator"] == "line:1"


@pytest.mark.parametrize(
    "text",
    [
        "Body text should use Times New Roman font.",
        "Body text must use Times New Roman or Arial font.",
        "正文必须使用宋体或黑体字体。",
        "正文字体必须为宋体和黑体。",
        "正文字体必须为中文宋体 英文Times New Roman。",
        "Body text must use Chinese SimSun English Times New Roman font.",
        "If accepted, body text must use Times New Roman font.",
        "中文摘要必须使用宋体字体。",
    ],
)
def test_ambiguous_or_limited_font_guidance_does_not_become_universal(text):
    world = analyze_world(
        "journal-test", "Test", [SourceInput("guide.txt", "guide_text", text.encode())]
    )
    assert "body_font_family" not in rules(world)
    assert world["coverage_gaps"]


def test_repeated_analysis_has_stable_version_and_source_order():
    sources = [
        SourceInput("template.docx", "template_docx", template_bytes()),
        SourceInput("guide.txt", "guide_text", b"All manuscript pages must use A4 paper."),
    ]
    first = analyze_world("journal-test", "Test Journal", sources)
    assert first == analyze_world("journal-test", "Test Journal", list(reversed(sources)))
    assert first == analyze_world("journal-test", "Test Journal", [*sources, sources[0]])
    assert first["version_id"].startswith("world-")
    assert all(source["source_id"] == "source-" + source["sha256"] for source in first["sources"])
    changed = analyze_world("journal-test", "Test Journal", sources, stage="revision")
    assert changed["version_id"] != first["version_id"]


def test_template_is_candidate_even_when_geometry_is_uniform():
    world = analyze_world(
        "journal-test", "Test", [SourceInput("template", "template_docx", template_bytes())]
    )
    assert len(world["rules"]) == 7
    assert all(rule["basis_status"] == "candidate" for rule in world["rules"])
    assert all(rule["scope"]["section_scope"] == "all_sections" for rule in world["rules"])
    assert rules(world)["page_width_twips"]["expected"] == 11906


def test_mixed_or_missing_sections_do_not_create_section_correspondence_rules():
    world = analyze_world(
        "journal-test",
        "Test",
        [
            SourceInput(
                "template",
                "template_docx",
                template_bytes(((11906, 16838, 1440, 1), (12240, 15840, None, 2))),
            )
        ],
    )
    assert world["rules"] == []
    assert {gap["code"] for gap in world["coverage_gaps"]} >= {
        "mixed_template_sections",
        "template_property_missing",
    }


@pytest.mark.parametrize(
    "text,property_name,expected",
    [
        ("All manuscript pages must use A4 paper.", "page_width_twips", 11906),
        ("All manuscript pages must use Letter paper.", "page_height_twips", 15840),
        ("All manuscript pages must have 25.4 mm margins on all sides.", "left_margin_twips", 1440),
        ("All manuscript pages must have top margins of 2.54 cm.", "top_margin_twips", 1440),
        ("全文所有页边距必须为1英寸。", "bottom_margin_twips", 1440),
        ("全文必须为2栏。", "columns", 2),
        ("全文必须使用A4纸张。", "page_height_twips", 16838),
    ],
)
def test_explicit_bounded_guide_requirements_are_confirmed(text, property_name, expected):
    world = analyze_world(
        "journal-test", "Test", [SourceInput("guide", "guide_text", text.encode())]
    )
    rule = rules(world)[property_name]
    assert rule["basis_status"] == "confirmed"
    assert rule["expected"] == expected
    assert rule["evidence"] == [
        {"source_id": world["sources"][0]["source_id"], "locator": "line:1", "quote": text}
    ]
    assert any("operator-supplied" in limitation for limitation in rule["limitations"])


@pytest.mark.parametrize(
    "text",
    [
        "If accepted: All manuscript pages must use A4 paper.",
        "All manuscript pages must not use A4 paper.",
        "All manuscript pages should use A4 paper.",
        "All manuscript pages must have 25 margins on all sides.",
        "A4 is recommended.\nAll manuscript pages must use 2 columns.",
        "If accepted:\nAll manuscript pages must use A4 paper.",
        "全文页边距建议为25毫米。",
    ],
)
def test_ambiguous_or_conditional_guidance_is_not_confirmed(text):
    world = analyze_world(
        "journal-test", "Test", [SourceInput("guide", "guide_text", text.encode())]
    )
    assert world["rules"] == []
    assert any(gap["locator"] == "line:1" for gap in world["coverage_gaps"])


def test_conflicting_guides_preserve_all_evidence_and_no_chosen_value():
    sources = [
        SourceInput("guide-a", "guide_text", b"All manuscript pages must use A4 paper."),
        SourceInput("guide-b", "guide_text", b"All manuscript pages must use Letter paper."),
    ]
    rule = rules(analyze_world("journal-test", "Test", sources))["page_width_twips"]
    assert rule["basis_status"] == "conflict"
    assert rule["expected"] is None
    assert len(rule["evidence"]) == 2


def test_clean_pdf_guide_yields_confirmed_rules_with_page_block_locators():
    payload = build_pdf(
        [
            [
                (50, 100, "All manuscript pages must use A4 paper.", 10.0, "helv"),
                (
                    50,
                    220,
                    "All manuscript pages must have 25 mm margins on all sides",
                    10.0,
                    "helv",
                ),
            ]
        ]
    )
    source = SourceInput("guide.pdf", "guide_pdf", payload)
    world = analyze_world("journal-test", "Test", [source])
    assert world["analyzer_version"] == ANALYZER_VERSION
    assert world["sources"][0]["status"] == "analyzed"
    by_property = {rule["property"]: rule for rule in world["rules"]}
    assert by_property["page_width_twips"]["expected"] == 11906
    assert by_property["page_height_twips"]["expected"] == 16838
    assert by_property["top_margin_twips"]["expected"] == 1417
    paper = by_property["page_width_twips"]
    assert paper["basis_status"] == "confirmed"
    assert paper["confirmation_method"] == "explicit_supplied_guide_pattern"
    assert paper["evidence"] == [
        {
            "source_id": source.source_id,
            "locator": "page:1/block:1",
            "quote": "All manuscript pages must use A4 paper.",
        }
    ]


def test_pdf_guide_with_prose_stays_entirely_unconfirmed():
    payload = build_pdf(
        [
            [
                (50, 100, "All manuscript pages must use A4 paper.", 10.0, "helv"),
                (50, 220, "The journal welcomes new submissions.", 10.0, "helv"),
            ]
        ]
    )
    world = analyze_world("journal-test", "Test", [SourceInput("guide.pdf", "guide_pdf", payload)])
    assert world["rules"] == []
    assert world["sources"][0]["status"] == "analyzed_with_gaps"
    ambiguous = [
        gap for gap in world["coverage_gaps"] if gap["code"] == "conditional_or_ambiguous_guide"
    ]
    assert {gap["locator"] for gap in ambiguous} == {"page:1/block:1", "page:1/block:2"}


def test_pdf_scanned_pages_become_explicit_reader_gaps():
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((50, 100), "All manuscript pages must use A4 paper.", fontsize=10.0)
    document.new_page()
    payload = document.tobytes()
    document.close()
    world = analyze_world("journal-test", "Test", [SourceInput("scan.pdf", "guide_pdf", payload)])
    assert world["sources"][0]["status"] == "analyzed_with_gaps"
    assert any(gap["code"] == "pdf_reader_issue" for gap in world["coverage_gaps"])
    assert all(gap["code"] != "empty_guide" for gap in world["coverage_gaps"])


def test_invalid_pdf_bytes_fail_analysis_loudly():
    with pytest.raises(WorldAnalysisError, match="not a readable PDF"):
        analyze_world(
            "journal-test", "Test", [SourceInput("guide.pdf", "guide_pdf", b"%PDF-captured")]
        )


def test_docx_guide_retains_paragraph_locator_and_rejects_hidden_text():
    payload = docx_bytes(
        "<w:p><w:r><w:t>All manuscript pages must use A4 paper.</w:t></w:r></w:p>"
        "<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>"
        "All manuscript pages must use 2 columns.</w:t></w:r></w:p>"
    )
    world = analyze_world(
        "journal-test", "Test", [SourceInput("guide.docx", "guide_docx", payload)]
    )
    assert (
        rules(world)["page_width_twips"]["evidence"][0]["locator"]
        == "word/document.xml#paragraph[1]"
    )
    assert "columns" not in rules(world)
    assert any(gap["code"] == "ambiguous_guide_paragraph" for gap in world["coverage_gaps"])


def test_invalid_utf8_is_refused():
    with pytest.raises(WorldAnalysisError, match="UTF-8"):
        analyze_world("journal-test", "Test", [SourceInput("guide", "guide_text", b"\xff")])


def test_unknown_heading_and_hidden_condition_do_not_promote_bounded_sentences():
    text = "For review articles:\nAll manuscript pages must use A4 paper."
    world = analyze_world(
        "journal-test", "Test", [SourceInput("guide", "guide_text", text.encode())]
    )
    assert world["rules"] == []
    payload = docx_bytes(
        "<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>If accepted:</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>All manuscript pages must use A4 paper.</w:t></w:r></w:p>"
    )
    world = analyze_world("journal-test", "Test", [SourceInput("guide", "guide_docx", payload)])
    assert world["rules"] == []


def test_empty_guide_records_explicit_coverage_gap():
    world = analyze_world("journal-test", "Test", [SourceInput("empty", "guide_text", b"\n  \n")])
    assert any(gap["code"] == "empty_guide" for gap in world["coverage_gaps"])


def test_source_name_is_a_label_but_null_and_untyped_kind_are_rejected():
    assert SourceInput("C:/captured/guide.txt", "guide_text", b"text").name.endswith("guide.txt")
    with pytest.raises(WorldAnalysisError):
        SourceInput("bad\x00name", "guide_text", b"text")
    with pytest.raises(WorldAnalysisError):
        SourceInput("label", [], b"text")


def test_captured_source_validation_refuses_rehashed_fabricated_rules():
    from copy import deepcopy

    from research_file_workbench.journals.analysis import validate_world_sources
    from research_file_workbench.journals.models import world_version_id

    source = SourceInput("guide", "guide_text", b"All manuscript pages must use A4 paper.")
    world = analyze_world("journal-test", "Test", [source])
    validate_world_sources(world, {source.source_id: source.content})
    forged = deepcopy(world)
    forged["rules"][0]["expected"] = 12240
    forged["rules"][0]["evidence"][0]["quote"] = "All manuscript pages must use Letter paper."
    forged["version_id"] = world_version_id(forged)
    with pytest.raises(WorldAnalysisError, match="differ from captured"):
        validate_world_sources(forged, {source.source_id: source.content})


def test_revised_world_validates_exact_manual_decision_chain():
    from copy import deepcopy

    from research_file_workbench.journals.analysis import validate_world_sources
    from research_file_workbench.journals.models import world_version_id
    from research_file_workbench.journals.revisions import revise_rule

    source = SourceInput("guide", "guide_text", b"All manuscript pages must use A4 paper.")
    world = analyze_world("journal-test", "Test", [source])
    revised = revise_rule(
        world, world["rules"][0]["rule_id"], 12240, "Local scope decision", "operator"
    )
    validate_world_sources(revised, {source.source_id: source.content})
    forged = deepcopy(revised)
    forged["manual_decisions"][0]["base_version_id"] = "world-" + "0" * 64
    forged["version_id"] = world_version_id(forged)
    with pytest.raises(WorldAnalysisError, match="history"):
        validate_world_sources(forged, {source.source_id: source.content})


def test_long_numeric_prose_remains_gap_instead_of_failing_decimal_conversion():
    text = "All manuscript pages must have " + "9" * 5000 + " mm margins on all sides."
    world = analyze_world(
        "journal-test", "Test", [SourceInput("guide", "guide_text", text.encode())]
    )
    assert world["rules"] == []
    assert world["coverage_gaps"]


def test_page_format_definition_sentence_yields_columns_and_dimensions():
    source = SourceInput(
        "tdsc-guide.txt",
        "guide_text",
        b"A double column page is defined as a 7.875\xe2\x80\xb3 x 10.75\xe2\x80\xb3 page "
        b"with 9.5-point type and 11.5-point vertical spacing.",
    )
    world = analyze_world("journal-test", "Test", [source])
    by_property = {rule["property"]: rule for rule in world["rules"]}
    assert by_property["columns"]["expected"] == 2
    assert by_property["page_width_twips"]["expected"] == 11340
    assert by_property["page_height_twips"]["expected"] == 15480
    assert by_property["body_font_size_halfpoints"]["expected"] == 19
    assert by_property["body_line_spacing_twips"]["expected"] == 230
    from research_file_workbench.journals.models import ASSURANCE_LIMITATION

    assert all(rule["limitations"] == [ASSURANCE_LIMITATION] for rule in world["rules"])
    assert not any(
        "no checkable" in limitation
        for rule in world["rules"]
        for limitation in rule["limitations"]
    )
