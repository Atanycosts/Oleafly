"""Source navigation preserves exact bytes, locators and independent rule authority."""

from copy import deepcopy

import pytest

from research_file_workbench.common.json_io import encode_json_object
from research_file_workbench.docx.report import READER_VERSION
from research_file_workbench.journals.analysis import analyze_world
from research_file_workbench.journals.evidence import (
    EVIDENCE_METHOD_VERSION,
    RELATED_FRAGMENT_LIMIT,
    build_world_evidence,
)
from research_file_workbench.journals.models import (
    SourceInput,
    WorldAnalysisError,
    world_version_id,
)
from research_file_workbench.journals.pdf_analysis import PDF_SOURCE_VERSION
from tests.journals.test_analysis import docx_bytes, template_bytes
from tests.journals.test_components import component
from tests.journals.test_pdf_analysis import build_pdf


def inspect_sources(*sources):
    world = analyze_world("journal-test", "Test Journal", sources)
    return world, build_world_evidence(
        world, {source.source_id: source.content for source in sources}
    )


def test_text_sentences_retain_exact_parent_offsets_and_repeated_occurrences():
    text = '  🔎 Margins are 25.4 mm.  "Use A4 paper." 中文指南。中文指南！  '
    source = SourceInput("guide.txt", "guide_text", text.encode())
    _, evidence = inspect_sources(source)
    paragraphs = [item for item in evidence["fragments"] if item["kind"] == "paragraph"]
    sentences = [item for item in evidence["fragments"] if item["kind"] == "sentence"]
    assert len(paragraphs) == 1
    assert paragraphs[0]["text"] == text
    assert [item["text"] for item in sentences] == [
        "🔎 Margins are 25.4 mm.",
        '"Use A4 paper."',
        "中文指南。",
        "中文指南！",
    ]
    assert evidence["offset_unit"] == "unicode_code_points"
    assert len({item["fragment_id"] for item in sentences}) == len(sentences)
    for sentence in sentences:
        assert sentence["parent_fragment_id"] == paragraphs[0]["fragment_id"]
        assert text[sentence["char_start"] : sentence["char_end"]] == sentence["text"]


def test_repeated_punctuation_does_not_become_a_standalone_sentence():
    _, evidence = inspect_sources(SourceInput("guide", "guide_text", b"Use A4?! Really!"))
    sentences = [item["text"] for item in evidence["fragments"] if item["kind"] == "sentence"]
    assert sentences == ["Use A4?!", "Really!"]


def test_exact_rule_links_are_distinct_from_ranked_similar_sources():
    exact = SourceInput("guide", "guide_text", b"All manuscript pages must use A4 paper.")
    related = SourceInput("notes", "guide_text", b"A4 paper is recommended for manuscript pages.")
    world, evidence = inspect_sources(exact, related)
    assert len(evidence["rule_links"]) == 2
    assert all(item["source_id"] == exact.source_id for item in evidence["rule_links"])
    fragments = {item["fragment_id"]: item for item in evidence["fragments"]}
    for link in evidence["rule_links"]:
        assert link["link_status"] == "located"
        assert len(link["fragment_ids"]) == 1
        fragment = fragments[link["fragment_ids"][0]]
        assert fragment["text"] == link["quote"]
        assert fragment["locator"] == "line:1"
    associations = [item for item in evidence["relations"] if item["kind"] == "related_source"]
    assert associations
    assert all(fragments[item["to_id"]]["source_id"] == related.source_id for item in associations)
    assert all(item["score_kind"] == "lexical_cosine" for item in associations)
    assert all("verdict" not in item and "probability" not in item for item in associations)
    assert {rule["basis_status"] for rule in world["rules"]} == {"confirmed"}


def test_evidence_is_deterministic_and_does_not_rewrite_the_world():
    source = SourceInput("guide", "guide_text", b"All manuscript pages must use 2 columns.")
    world = analyze_world("journal-test", "Test Journal", [source])
    original = deepcopy(world)
    payloads = {source.source_id: source.content}
    first = build_world_evidence(world, payloads)
    assert first == build_world_evidence(world, payloads)
    assert world == original
    assert first["method_version"] == EVIDENCE_METHOD_VERSION
    assert first["world_version_id"] == world["version_id"]


def test_docx_table_cells_and_paragraphs_have_separate_explicit_ancestry():
    payload = docx_bytes(
        "<w:p><w:r><w:t>A paragraph. Another sentence.</w:t></w:r></w:p>"
        '<w:tbl><w:tblGrid><w:gridCol w:w="1200"/></w:tblGrid><w:tr><w:tc>'
        "<w:p><w:r><w:t>Cell content. More text.</w:t></w:r></w:p>"
        "</w:tc></w:tr></w:tbl>"
    )
    _, evidence = inspect_sources(SourceInput("guide.docx", "guide_docx", payload))
    fragments = {item["fragment_id"]: item for item in evidence["fragments"]}
    cells = [item for item in fragments.values() if item["kind"] == "table_cell"]
    assert len(cells) == 1
    cell = cells[0]
    assert cell["locator"] == "word/document.xml#table[1]/row[1]/cell[1]"
    assert cell["content"]["row_index"] == 0
    assert fragments[cell["parent_fragment_id"]]["content"]["object_type"] == "table"
    assert fragments[cell["parent_fragment_id"]]["locator"] == "word/document.xml#table[1]"
    paragraphs = [item for item in fragments.values() if item["kind"] == "paragraph"]
    assert len(paragraphs) == 2
    assert all(item["parent_fragment_id"] is None for item in paragraphs)
    cell_sentences = [
        item for item in fragments.values() if item["parent_fragment_id"] == cell["fragment_id"]
    ]
    assert [item["text"] for item in cell_sentences] == ["Cell content.", "More text."]


def test_hidden_docx_text_remains_observation_with_its_flags():
    payload = docx_bytes(
        "<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>"
        "All manuscript pages must use 2 columns.</w:t></w:r></w:p>"
    )
    world, evidence = inspect_sources(SourceInput("guide.docx", "guide_docx", payload))
    paragraph = next(item for item in evidence["fragments"] if item["kind"] == "paragraph")
    assert paragraph["content"]["hidden"] is True
    assert world["rules"] == []
    assert evidence["rule_links"] == []


def test_template_rule_links_point_to_declared_section_nodes():
    world, evidence = inspect_sources(
        SourceInput("template.docx", "template_docx", template_bytes())
    )
    fragments = {item["fragment_id"]: item for item in evidence["fragments"]}
    assert len(evidence["rule_links"]) == len(world["rules"]) == 7
    for link in evidence["rule_links"]:
        assert link["link_status"] == "located"
        fragment = fragments[link["fragment_ids"][0]]
        assert fragment["kind"] == "docx_node"
        assert fragment["content"]["object_type"] == "section"
        assert fragment["content"]["declared_values"]["columns"] == 1


def test_component_rule_and_provenance_keep_their_parent_component():
    payload = encode_json_object(component()).encode()
    _, evidence = inspect_sources(SourceInput("component.json", "rule_component_json", payload))
    root = next(item for item in evidence["fragments"] if item["kind"] == "component")
    declarations = [
        item for item in evidence["fragments"] if item["kind"] in {"component_rule", "source_quote"}
    ]
    assert root["content"]["component_id"] == "page-geometry"
    assert root["content"]["applicability"]["stages"] == ["initial_submission"]
    assert len(declarations) == 2
    assert all(item["parent_fragment_id"] == root["fragment_id"] for item in declarations)
    assert all(item["link_status"] == "located" for item in evidence["rule_links"])


def test_duplicate_component_declarations_are_suggestions_and_remain_separate():
    first = component()
    second = deepcopy(first)
    second["component_id"] = "other-page-geometry"
    sources = [
        SourceInput("first.json", "rule_component_json", encode_json_object(first).encode()),
        SourceInput("second.json", "rule_component_json", encode_json_object(second).encode()),
    ]
    world, evidence = inspect_sources(*sources)
    duplicates = [item for item in evidence["relations"] if item["kind"] == "possible_duplicate"]
    assert len(duplicates) == 1
    assert duplicates[0]["from_id"] != duplicates[0]["to_id"]
    assert len([item for item in evidence["fragments"] if item["kind"] == "component_rule"]) == 2
    assert world["rules"][0]["basis_status"] == "candidate"
    assert len(world["rules"][0]["evidence"]) == 4


def test_duplicate_file_labels_and_docx_roles_do_not_duplicate_fragments():
    payload = template_bytes()
    sources = [
        SourceInput("first.docx", "template_docx", payload),
        SourceInput("second.docx", "template_docx", payload),
        SourceInput("guide.docx", "guide_docx", payload),
    ]
    _, evidence = inspect_sources(*sources)
    assert len(evidence["sources"]) == 3
    assert len({item["fragment_id"] for item in evidence["fragments"]}) == len(
        evidence["fragments"]
    )
    assert all(len(item["fragment_ids"]) == 1 for item in evidence["rule_links"])


def test_pdf_fragments_bind_pages_regions_and_sentences():
    payload = build_pdf(
        [
            [
                (50, 100, "Margins must be 25 mm. Use A4 paper.", 10.0, "helv"),
                (50, 220, "Section Heading", 20.0, "helv"),
            ]
        ]
    )
    _, evidence = inspect_sources(SourceInput("guide.pdf", "guide_pdf", payload))
    blocks = [
        item for item in evidence["fragments"] if item["kind"] in ("pdf_block", "pdf_heading")
    ]
    sentences = [item for item in evidence["fragments"] if item["kind"] == "sentence"]
    assert evidence["method_version"] == EVIDENCE_METHOD_VERSION
    assert evidence["pdf_source_version"] == PDF_SOURCE_VERSION
    assert evidence["sources"][0]["extraction_status"] == "extracted"
    assert evidence["sources"][0]["reader_issues"] == []
    assert len(blocks) == 2
    paragraph = next(item for item in blocks if item["kind"] == "pdf_block")
    assert paragraph["locator"] == "page:1/block:1"
    assert paragraph["content"]["page"] == 1
    assert len(paragraph["content"]["bbox"]) == 4
    assert all(0 <= value <= 595 for value in paragraph["content"]["bbox"][::2])
    assert [
        item["text"] for item in sentences if item["parent_fragment_id"] == paragraph["fragment_id"]
    ] == [
        "Margins must be 25 mm.",
        "Use A4 paper.",
    ]
    heading = next(item for item in blocks if item["kind"] == "pdf_heading")
    assert heading["locator"] == "page:1/block:2"
    assert heading["content"]["page"] == 1


def test_invalid_pdf_bytes_fail_loudly_without_fabricating_fragments():
    with pytest.raises(WorldAnalysisError, match="not a readable PDF"):
        inspect_sources(SourceInput("guide.pdf", "guide_pdf", b"%PDF-captured"))


def test_pdf_rule_evidence_links_locate_page_bound_fragments():
    payload = build_pdf([[(50, 100, "All manuscript pages must use A4 paper.", 10.0, "helv")]])
    source = SourceInput("guide.pdf", "guide_pdf", payload)
    world, evidence = inspect_sources(source)
    assert len(world["rules"]) == 2  # A4 paper width and height from one line
    links = [link for link in evidence["rule_links"] if link["locator"] == "page:1/block:1"]
    assert links and all(link["link_status"] == "located" for link in links)
    located = links[0]["fragment_ids"]
    fragments = {item["fragment_id"]: item for item in evidence["fragments"]}
    assert all(fragment_id in fragments for fragment_id in located)
    assert fragments[located[0]]["kind"] == "pdf_block"


@pytest.mark.parametrize("mutation", ["missing", "extra", "changed"])
def test_source_identity_must_match_before_any_fragments_are_returned(mutation):
    source = SourceInput("guide", "guide_text", b"All manuscript pages must use 2 columns.")
    world = analyze_world("journal-test", "Test", [source])
    payloads = {source.source_id: source.content}
    if mutation == "missing":
        payloads.clear()
    elif mutation == "extra":
        payloads["source-extra"] = b"extra"
    else:
        payloads[source.source_id] = b"changed"
    with pytest.raises(WorldAnalysisError, match="source"):
        build_world_evidence(world, payloads)


def test_historical_rules_are_read_without_executing_an_old_analyzer():
    source = SourceInput("guide", "guide_text", b"All manuscript pages must use 2 columns.")
    world = analyze_world("journal-test", "Test", [source])
    world["analyzer_version"] = "journal-world-analyzer-historical"
    world["reader_version"] = "s1-reader-historical"
    world["version_id"] = world_version_id(world)
    evidence = build_world_evidence(world, {source.source_id: source.content})
    assert evidence["reader_version"] == READER_VERSION
    assert evidence["world_version_id"] == world["version_id"]
    assert world["reader_version"] == "s1-reader-historical"


def test_related_source_ranking_is_bounded_and_never_adds_authoritative_evidence():
    exact = SourceInput("guide", "guide_text", b"All manuscript pages must use A4 paper.")
    notes = SourceInput(
        "notes",
        "guide_text",
        "\n".join(f"A4 manuscript paper suggestion {index}." for index in range(20)).encode(),
    )
    world, evidence = inspect_sources(exact, notes)
    related = [item for item in evidence["relations"] if item["kind"] == "related_source"]
    for rule in world["rules"]:
        suggestions = [item for item in related if item["from_id"] == rule["rule_id"]]
        assert len(suggestions) == RELATED_FRAGMENT_LIMIT
        assert [item["score"] for item in suggestions] == sorted(
            (item["score"] for item in suggestions), reverse=True
        )
        assert len(rule["evidence"]) == 1
