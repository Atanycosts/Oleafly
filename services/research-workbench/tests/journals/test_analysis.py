"""Independent examples for conservative journal-world source analysis."""

from collections.abc import Mapping
from copy import deepcopy
from io import BytesIO
from zipfile import ZipFile

import pymupdf
import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import encode_json_object
from research_file_workbench.journals.analysis import analyze_world, validate_world_sources
from research_file_workbench.journals.evidence import build_world_evidence
from research_file_workbench.journals.models import (
    ANALYZER_VERSION,
    SourceInput,
    WorldAnalysisError,
    property_unit,
    world_version_id,
)
from research_file_workbench.journals.revisions import revise_rule
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


def component_bytes(
    requirements,
    *,
    quote="Captured declaration for explicit geometry review.",
    journal_id="journal-test",
    stage="initial_submission",
):
    requirements = requirement_items(requirements)
    document = {
        "schema_version": "journal-rule-component-1.0.0",
        "component_id": "explicit-page-geometry",
        "component_version": "1.0.0",
        "applicability": {
            "journal_ids": [journal_id],
            "article_types": ["research_article"],
            "stages": [stage],
            "languages": ["en"],
            "basis": "Test declaration with retained source provenance",
        },
        "sources": [
            {
                "source_id": "guide-reference",
                "title": "Captured guide excerpt",
                "locator": "captured source",
                "quote": quote,
            }
        ],
        "rules": [
            {
                "property": property_name,
                "expected": expected,
                "unit": property_unit(property_name),
                "source_refs": ["guide-reference"],
            }
            for property_name, expected in requirements
        ],
    }
    return encode_json_object(document).encode()


def requirement_items(requirements):
    return list(requirements.items()) if isinstance(requirements, Mapping) else list(requirements)


def declarative_world(
    requirements,
    *,
    quote="Captured declaration for explicit geometry review.",
    journal_id="journal-test",
    name="Test",
    stage="initial_submission",
):
    return analyze_world(
        journal_id,
        name,
        [
            SourceInput(
                "component.json",
                "rule_component_json",
                component_bytes(
                    requirements,
                    quote=quote,
                    journal_id=journal_id,
                    stage=stage,
                ),
            )
        ],
        stage=stage,
    )


def explicit_world(
    requirements,
    *,
    quote="Captured declaration for explicit geometry review.",
    journal_id="journal-test",
    name="Test",
    stage="initial_submission",
    actor_id="test-operator",
):
    items = requirement_items(requirements)
    world = declarative_world(
        items,
        quote=quote,
        journal_id=journal_id,
        name=name,
        stage=stage,
    )
    by_property = rules(world)
    for property_name, expected in items:
        world = revise_rule(
            world,
            by_property[property_name]["rule_id"],
            expected,
            f"Explicit test decision for {property_name}",
            actor_id,
        )
    return world


def rules(world):
    return {rule["property"]: rule for rule in world["rules"]}


@pytest.mark.parametrize(
    "text",
    [
        "All manuscript body text must use Times New Roman font.",
        "Body text must use PT Serif font.",
        "正文必须使用宋体字体。",
        "All manuscript pages must use A4 paper.",
        "All manuscript pages must have 25.4 mm margins on all sides.",
        "全文必须为2栏。",
        "A double column page is defined as a 7.875″ x 10.75″ page with 9.5-point type.",
        "If accepted: All manuscript pages must use A4 paper.",
    ],
)
def test_varied_guide_prose_yields_no_automatic_rules_and_retains_exact_evidence(text):
    payload = text.encode()
    source = SourceInput("guide.txt", "guide_text", payload)
    world = analyze_world("journal-test", "Test", [source])

    assert world["rules"] == []
    assert world["analyzer_version"] == ANALYZER_VERSION
    assert world["sources"][0]["status"] == "analyzed_with_gaps"
    assert world["sources"][0]["sha256"] == sha256_bytes(payload)
    guide_gaps = [
        gap for gap in world["coverage_gaps"] if gap["code"] == "guide_requires_interpretation"
    ]
    assert guide_gaps == [
        {
            "code": "guide_requires_interpretation",
            "source_id": source.source_id,
            "property": None,
            "locator": None,
            "message": "Guide retained for user or Agent interpretation; no requirements are "
            "inferred from prose. Add explicit structured requirements with source references.",
        }
    ]

    evidence = build_world_evidence(world, {source.source_id: payload})
    paragraph = next(item for item in evidence["fragments"] if item["kind"] == "paragraph")
    assert paragraph["text"] == text
    assert evidence["rule_links"] == []


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


def test_declarative_rule_remains_candidate_until_explicit_human_decision():
    quote = "Submission pages use A4 paper."
    world = declarative_world([("page_width_twips", 11906)], quote=quote)
    rule = world["rules"][0]
    assert rule["basis_status"] == "candidate"
    assert rule["confirmation_method"] == "candidate_observation"
    assert rule["evidence"][1]["quote"] == quote
    assert "manual_decisions" not in world

    revised = revise_rule(
        world,
        rule["rule_id"],
        11906,
        "Editor explicitly confirmed this source for initial submission",
        "editor",
    )
    confirmed = revised["rules"][0]
    assert confirmed["basis_status"] == "confirmed"
    assert confirmed["confirmation_method"] == "human_decision"
    assert confirmed["evidence"] == rule["evidence"]
    assert revised["manual_decisions"][0]["base_version_id"] == world["version_id"]


def test_component_sources_preserve_conflict_until_explicit_choice():
    first = SourceInput(
        "a.json",
        "rule_component_json",
        component_bytes(
            [("page_width_twips", 11906)],
            quote="All manuscript pages must use A4 paper.",
        ),
    )
    second = SourceInput(
        "b.json",
        "rule_component_json",
        component_bytes(
            [("page_width_twips", 12240)],
            quote="All manuscript pages must use Letter paper.",
        ),
    )
    world = analyze_world("journal-test", "Test", [first, second])
    rule = world["rules"][0]
    assert rule["basis_status"] == "conflict"
    assert rule["expected"] is None
    assert {item["quote"] for item in rule["evidence"]} >= {
        "All manuscript pages must use A4 paper.",
        "All manuscript pages must use Letter paper.",
    }

    revised = revise_rule(world, rule["rule_id"], 11906, "Use A4 for this context", "editor")
    assert revised["rules"][0]["expected"] == 11906
    assert revised["rules"][0]["evidence"] == rule["evidence"]


def test_pdf_guide_yields_no_rules_and_retains_page_bound_fragments():
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
    assert world["rules"] == []
    assert world["sources"][0]["status"] == "analyzed_with_gaps"
    assert any(gap["code"] == "guide_requires_interpretation" for gap in world["coverage_gaps"])

    evidence = build_world_evidence(world, {source.source_id: payload})
    assert [item["text"] for item in evidence["fragments"] if item["kind"] == "pdf_block"] == [
        "All manuscript pages must use A4 paper.",
        "All manuscript pages must have 25 mm margins on all sides",
    ]
    assert evidence["rule_links"] == []


def test_pdf_scanned_pages_become_explicit_reader_gaps():
    document = pymupdf.open()
    page = document.new_page()
    page.insert_text((50, 100), "All manuscript pages must use A4 paper.", fontsize=10.0)
    document.new_page()
    payload = document.tobytes()
    document.close()
    world = analyze_world("journal-test", "Test", [SourceInput("scan.pdf", "guide_pdf", payload)])
    assert world["rules"] == []
    assert world["sources"][0]["status"] == "analyzed_with_gaps"
    assert any(gap["code"] == "pdf_reader_issue" for gap in world["coverage_gaps"])
    assert any(gap["code"] == "guide_requires_interpretation" for gap in world["coverage_gaps"])


def test_invalid_pdf_bytes_fail_analysis_loudly():
    with pytest.raises(WorldAnalysisError, match="not a readable PDF"):
        analyze_world(
            "journal-test", "Test", [SourceInput("guide.pdf", "guide_pdf", b"%PDF-captured")]
        )


def test_docx_guide_retains_exact_paragraph_and_creates_no_rules():
    text = "All manuscript pages must use A4 paper."
    payload = docx_bytes(f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>")
    source = SourceInput("guide.docx", "guide_docx", payload)
    world = analyze_world("journal-test", "Test", [source])
    assert world["rules"] == []
    evidence = build_world_evidence(world, {source.source_id: payload})
    paragraph = next(item for item in evidence["fragments"] if item["kind"] == "paragraph")
    assert paragraph["text"] == text
    assert paragraph["locator"] == "word/document.xml#paragraph[1]"
    assert evidence["rule_links"] == []


def test_guide_text_and_explicit_component_coexist_without_promoting_prose():
    guide_text = b"All manuscript pages must use A4 paper."
    frame = SourceInput("guide.txt", "guide_text", guide_text)
    component = SourceInput(
        "component.json",
        "rule_component_json",
        component_bytes([("page_width_twips", 12240)], quote="The selected page is Letter."),
    )
    world = analyze_world("journal-test", "Test", [frame, component])
    rule = world["rules"][0]
    assert rule["expected"] == 12240
    assert rule["basis_status"] == "candidate"
    assert all(item["source_id"] == component.source_id for item in rule["evidence"])
    assert any(gap["source_id"] == frame.source_id for gap in world["coverage_gaps"])


def test_invalid_utf8_is_refused():
    with pytest.raises(WorldAnalysisError, match="UTF-8"):
        analyze_world("journal-test", "Test", [SourceInput("guide", "guide_text", b"\xff")])


def test_empty_guide_records_interpretation_gap_without_generating_rules():
    world = analyze_world("journal-test", "Test", [SourceInput("empty", "guide_text", b"\n  \n")])
    assert world["rules"] == []
    assert any(gap["code"] == "guide_requires_interpretation" for gap in world["coverage_gaps"])
    assert all(gap["code"] != "empty_guide" for gap in world["coverage_gaps"])


def test_source_name_is_a_label_but_null_and_untyped_kind_are_rejected():
    assert SourceInput("C:/captured/guide.txt", "guide_text", b"text").name.endswith("guide.txt")
    with pytest.raises(WorldAnalysisError):
        SourceInput("bad\x00name", "guide_text", b"text")
    with pytest.raises(WorldAnalysisError):
        SourceInput("label", [], b"text")


def test_captured_source_validation_refuses_rehashed_fabricated_rules():
    source = SourceInput(
        "component.json",
        "rule_component_json",
        component_bytes([("columns", 2)]),
    )
    world = analyze_world("journal-test", "Test", [source])
    validate_world_sources(world, {source.source_id: source.content})
    forged = deepcopy(world)
    forged["rules"][0]["expected"] = 1
    forged["version_id"] = world_version_id(forged)
    with pytest.raises(WorldAnalysisError, match="differ from captured"):
        validate_world_sources(forged, {source.source_id: source.content})


def test_revised_world_validates_exact_manual_decision_chain():
    source = SourceInput(
        "component.json",
        "rule_component_json",
        component_bytes([("columns", 2)]),
    )
    world = analyze_world("journal-test", "Test", [source])
    revised = revise_rule(
        world, world["rules"][0]["rule_id"], 2, "Local scope decision", "operator"
    )
    validate_world_sources(revised, {source.source_id: source.content})
    forged = deepcopy(revised)
    forged["manual_decisions"][0]["base_version_id"] = "world-" + "0" * 64
    forged["version_id"] = world_version_id(forged)
    with pytest.raises(WorldAnalysisError, match="history"):
        validate_world_sources(forged, {source.source_id: source.content})
