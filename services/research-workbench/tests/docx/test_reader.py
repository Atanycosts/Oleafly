from pathlib import Path
from xml.etree import ElementTree
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.docx import DocxReadError, read_docx
from research_file_workbench.docx.reader import read_docx_bytes

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx"


def test_reader_inventories_parts_and_relationships() -> None:
    source = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"

    result = read_docx(source)

    assert result.source_sha256 == sha256_file(source)
    assert any(
        part.part_path == "word/document.xml" and part.status == "parsed" for part in result.parts
    )
    assert any(
        relation.source_part == "word/document.xml"
        and relation.resolved_target == "word/header1.xml"
        for relation in result.relationships
    )
    assert any(
        relation.target_mode == "External"
        and relation.target.startswith("https://example.invalid/")
        and relation.resolved_target is None
        for relation in result.relationships
    )


def test_file_and_persistent_bytes_use_identical_docx_parsing() -> None:
    source = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"
    result = read_docx(source)
    assert read_docx_bytes(source.read_bytes(), source_label=result.source_path) == result


def test_invalid_persistent_bytes_are_not_a_successful_empty_document() -> None:
    with pytest.raises(DocxReadError, match="Invalid DOCX ZIP"):
        read_docx_bytes(b"not a zip", source_label="artifact-version-invalid")


def test_reader_extracts_regions_and_preserves_field_state() -> None:
    source = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"

    result = read_docx(source)
    blocks_by_marker = {
        block.text: block for block in result.text_blocks if "RFW-FX-RF-" in block.text
    }

    assert any(
        block.region == "body" and "RFW-FX-RF-BODY-001" in block.text
        for block in result.text_blocks
    )
    assert any(
        block.region == "textbox" and "RFW-FX-RF-TEXTBOX-001" in block.text
        for block in result.text_blocks
    )
    assert any(
        block.region == "header" and "RFW-FX-RF-HEADER-001" in block.text
        for block in result.text_blocks
    )
    assert any(
        block.region == "footer" and "RFW-FX-RF-FOOTER-001" in block.text
        for block in result.text_blocks
    )
    assert any(
        block.region == "footnote" and "RFW-FX-RF-FOOTNOTE-BODY-001" in block.text
        for block in result.text_blocks
    )
    assert any(
        block.region == "endnote" and "RFW-FX-RF-ENDNOTE-BODY-001" in block.text
        for block in result.text_blocks
    )
    assert any(
        block.hidden and "RFW-FX-RF-HIDDEN-TEXT-001" in block.text for block in result.text_blocks
    )
    assert any(
        block.contains_field_code and "RFW-FX-RF-XREF-TARGET-001" in block.text
        for block in result.text_blocks
    )
    assert blocks_by_marker


def test_reader_reports_broken_relationships_without_dropping_them() -> None:
    source = FIXTURE_ROOT / "faults/s1-broken-relationships/s1-broken-relationships.docx"

    result = read_docx(source)

    assert any(
        relation.relationship_id == "rIdRfwMissingInternalTarget"
        for relation in result.relationships
    )
    assert any(
        relation.relationship_id == "rIdRfwMissingExternalDependency"
        for relation in result.relationships
    )
    assert any(issue.startswith("unresolved-relationship:") for issue in result.issues)


def test_reader_extracts_table_grid_and_image_relationships() -> None:
    source = FIXTURE_ROOT / "normal/s1-figures-tables/s1-figures-tables.docx"

    result = read_docx(source)

    assert len(result.tables) == 2
    first_table, second_table = result.tables
    assert len(first_table.rows) == 56
    assert first_table.grid_widths_twips == (3312, 3312, 3312)
    assert first_table.repeat_header_rows == (0,)
    assert second_table.rows[0][0].grid_span == 2
    assert second_table.rows[0][0].vertical_merge == "none"
    assert {image.container for image in result.images} == {"inline", "anchored"}
    assert all(image.resource_part == "word/media/image1.png" for image in result.images)
    assert all(image.width_emu == 1828800 and image.height_emu == 914400 for image in result.images)
    assert (
        next(image for image in result.images if image.container == "anchored").wrap_type
        == "wrapSquare"
    )


def test_reader_preserves_math_and_nested_field_boundaries() -> None:
    source = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"

    result = read_docx(source)

    assert [(item.kind, item.text) for item in result.math_objects] == [
        ("inline", "x+1"),
        ("display", "ab"),
    ]
    assert all("oMath" in item.omml_source for item in result.math_objects)
    merge_field = next(item for item in result.fields if item.field_kind == "mergefield")
    assert merge_field.instruction == "MERGEFIELD RFW_VALUE"
    assert merge_field.boundary_sequence == ("begin", "separate", "end")
    outer_field = next(item for item in result.fields if item.field_kind == "if")
    assert outer_field.boundary_sequence == (
        "begin",
        "begin",
        "separate",
        "end",
        "separate",
        "end",
    )
    assert outer_field.nested_level == 0


def test_repeated_fields_in_one_paragraph_have_distinct_source_occurrences(tmp_path: Path) -> None:
    source = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"
    destination = tmp_path / "repeated-fields.docx"
    namespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    with ZipFile(source) as original, ZipFile(destination, "w", ZIP_DEFLATED) as modified:
        for entry in original.infolist():
            content = original.read(entry.filename)
            if entry.filename == "word/document.xml":
                document = ElementTree.fromstring(content)
                body = document.find(f"{{{namespace}}}body")
                paragraph = ElementTree.Element(f"{{{namespace}}}p")
                # Two identical REF instructions remain separate source objects.
                for _ in range(2):
                    for tag, text, boundary in (
                        ("fldChar", None, "begin"),
                        ("instrText", "REF repeated_target", None),
                        ("fldChar", None, "separate"),
                        ("t", "same result", None),
                        ("fldChar", None, "end"),
                    ):
                        run = ElementTree.SubElement(paragraph, f"{{{namespace}}}r")
                        element = ElementTree.SubElement(run, f"{{{namespace}}}{tag}")
                        element.text = text
                        if boundary is not None:
                            element.set(f"{{{namespace}}}fldCharType", boundary)
                body.insert(0, paragraph)
                content = ElementTree.tostring(document, encoding="utf-8", xml_declaration=True)
            modified.writestr(entry, content)

    from research_file_workbench.docx.query import ReadQuery, query_docx

    result = read_docx(destination)
    fields = [item for item in result.fields if item.instruction == "REF repeated_target"]
    assert len(fields) == 2
    assert fields[0].node_locator == fields[1].node_locator
    assert [item.occurrence_index for item in fields] == [1, 2]
    response = query_docx(
        result,
        ReadQuery(object_type="field", page_size=100),
        task_id="repeated-fields",
        actor_id="test-operator",
        client_id="test-client",
    )
    ids = [item["object_id"] for item in response["items"]]
    assert len(ids) == len(set(ids)) == len(result.fields)


def test_reader_extracts_sections_and_explicit_breaks() -> None:
    source = FIXTURE_ROOT / "normal/s1-sections-layout/s1-sections-layout.docx"

    result = read_docx(source)

    assert len(result.sections) == 5
    assert result.sections[0].attached_to == "paragraph"
    assert result.sections[2].orientation == "landscape"
    assert result.sections[3].columns == 2
    assert result.sections[4].attached_to == "body"
    assert [item.break_type for item in result.breaks] == ["column", "page"]


def test_reader_resolves_style_inheritance_and_numbering() -> None:
    source = FIXTURE_ROOT / "normal/s1-sections-layout/s1-sections-layout.docx"

    result = read_docx(source)
    styles = {item.style_id: item for item in result.styles}

    assert styles["RFWFixtureChild"].source_chain == (
        "RFWFixtureChild",
        "RFWFixtureBase",
        "Normal",
    )
    assert styles["RFWFixtureChild"].font_ascii == "Arial"
    assert styles["RFWFixtureChild"].font_size_pt == 11
    assert styles["RFWFixtureChild"].italic is True
    assert styles["RFWFixtureChild"].space_after_twips == 160
    assert styles["ListNumber"].num_id == 5
    assert any(item.num_id == 5 and item.abstract_num_id == 7 for item in result.numbering)
    numbered_blocks = [item for item in result.text_blocks if item.numbering_id == 5]
    assert len(numbered_blocks) == 3


def test_reader_preserves_reference_targets() -> None:
    source = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"

    result = read_docx(source)
    references = {(item.kind, item.reference_id): item for item in result.references}

    assert references[("footnote_reference", "2")].target_part == "word/footnotes.xml"
    assert references[("endnote_reference", "2")].target_part == "word/endnotes.xml"
    assert references[("comment_anchor", "0")].target_part == "word/comments.xml"
    assert references[("bookmark", "42")].reference_name == "RFW_XREF_TARGET_001"
    hyperlink = next(item for item in result.references if item.kind == "hyperlink")
    assert hyperlink.target_part == "https://example.invalid/rfw-fixture/external-target-001"
    assert hyperlink.parse_status == "parsed"


def test_reader_registers_complex_objects_without_parsing_them() -> None:
    source = FIXTURE_ROOT / "native/s1-native-complex-objects/s1-native-complex-objects.docx"

    result = read_docx(source)
    objects_by_kind = {item.kind: item for item in result.complex_objects}

    assert {"chart", "ole", "group_drawing"}.issubset(objects_by_kind)
    assert objects_by_kind["chart"].parse_status == "unsupported"
    assert objects_by_kind["ole"].parse_status == "unsupported"
    assert objects_by_kind["group_drawing"].parse_status == "unsupported"
    assert "word/charts/chart1.xml" in objects_by_kind["chart"].related_parts
    assert "word/embeddings/oleObject1.bin" in objects_by_kind["ole"].related_parts
    assert objects_by_kind["ole"].available_preview == ("word/media/image1.emf",)
    assert not result.issues
    group_texts = [
        block.text for block in result.text_blocks if "RFW-FX-EO-GROUP-SHAPE-" in block.text
    ]
    assert group_texts == [
        "RFW-FX-EO-GROUP-SHAPE-A-001",
        "RFW-FX-EO-GROUP-SHAPE-B-001",
    ]


def test_reader_rejects_non_docx_package(tmp_path: Path) -> None:
    source = tmp_path / "not-a-docx.docx"
    source.write_bytes(b"not a zip")

    with pytest.raises(DocxReadError, match="Invalid DOCX ZIP package"):
        read_docx(source)
