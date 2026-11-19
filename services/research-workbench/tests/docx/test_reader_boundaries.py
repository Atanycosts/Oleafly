"""Boundary regressions for DOCX package, source text, fields, and style parsing."""

import struct
from io import BytesIO
from zipfile import ZipFile

import pytest

from research_file_workbench.docx.models import DocxReadError, DocxReadResult
from research_file_workbench.docx.reader import read_docx_bytes
from research_file_workbench.docx.report import READER_VERSION, docx_read_result_to_report

WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main"
CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart"
VML = "urn:schemas-microsoft-com:vml"


def _read(body: str = "<w:p><w:r><w:t>Body</w:t></w:r></w:p>", **parts: str) -> DocxReadResult:
    stream = BytesIO()
    with ZipFile(stream, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="xml" ContentType="application/xml"/></Types>',
        )
        archive.writestr(
            "word/document.xml",
            f'<w:document xmlns:w="{WORD}" xmlns:m="{MATH}" xmlns:mc="{MC}" '
            f'xmlns:r="{REL}" xmlns:wp="{WP}" xmlns:a="{DRAWING}" xmlns:c="{CHART}" '
            f'xmlns:v="{VML}">'
            f"<w:body>{body}</w:body></w:document>",
        )
        for name, content in parts.items():
            archive.writestr(name, content)
    return read_docx_bytes(stream.getvalue(), source_label="in-memory-regression.docx")


def _relationships(*entries: tuple[str, str, str]) -> str:
    return (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(
            f'<Relationship Id="{identifier}" Type="{REL}/{kind}" Target="{target}"/>'
            for identifier, kind, target in entries
        )
        + "</Relationships>"
    )


def _picture(identifier: str = "image") -> str:
    return (
        '<w:drawing><wp:inline><wp:extent cx="100" cy="200"/>'
        '<wp:docPr id="1" name="image"/><a:graphic><a:graphicData>'
        f'<a:blip r:embed="{identifier}"/></a:graphicData></a:graphic></wp:inline></w:drawing>'
    )


def _vml_picture(identifier: str = "vmlImage") -> str:
    return f'<w:pict><v:shape><v:imagedata r:id="{identifier}"/></v:shape></w:pict>'


def test_zero_abstract_numbering_id_retains_its_declared_level() -> None:
    result = _read(
        **{
            "word/numbering.xml": f'<w:numbering xmlns:w="{WORD}">'
            '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0">'
            '<w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>'
            '</w:lvl></w:abstractNum><w:num w:numId="1">'
            '<w:abstractNumId w:val="0"/></w:num></w:numbering>'
        }
    )
    assert result.numbering[0].levels == ((0, "decimal", "%1."),)
    assert result.numbering[0].parse_status == "parsed"


def test_missing_parent_style_keeps_declared_values_and_visible_incomplete_chain() -> None:
    result = _read(
        **{
            "word/styles.xml": f'<w:styles xmlns:w="{WORD}">'
            '<w:style w:type="paragraph" w:styleId="Child">'
            '<w:basedOn w:val="MissingBase"/><w:rPr><w:sz w:val="24"/></w:rPr>'
            "</w:style></w:styles>"
        }
    )
    style = result.styles[0]
    assert style.based_on == "MissingBase"
    assert style.source_chain == ("Child",)
    assert style.font_size_pt == 12
    assert "style_inheritance" in style.unconfirmed_fields
    assert "missing-style-base:Child:MissingBase" in result.issues


def test_style_cycle_is_visible_even_when_all_supported_properties_are_declared() -> None:
    result = _read(
        **{
            "word/styles.xml": f'<w:styles xmlns:w="{WORD}">'
            '<w:style w:type="paragraph" w:styleId="Self"><w:basedOn w:val="Self"/>'
            '<w:pPr><w:spacing w:after="0"/><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr>'
            '<w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="24"/><w:i/></w:rPr>'
            "</w:style></w:styles>"
        }
    )
    assert result.styles[0].unconfirmed_fields == ("style_inheritance",)
    assert "style-inheritance-cycle:Self" in result.issues


def test_missing_package_target_does_not_become_a_parsed_image() -> None:
    result = _read(
        f"<w:p><w:r>{_picture()}</w:r></w:p>",
        **{"word/_rels/document.xml.rels": _relationships(("image", "image", "media/missing.png"))},
    )
    assert result.relationships[0].resolved_target is None
    assert result.images[0].resource_part is None
    assert result.images[0].parse_status == "partial"
    assert any(issue.startswith("unresolved-relationship:") for issue in result.issues)


def test_vml_picture_is_unsupported_without_changing_drawing_image_count() -> None:
    result = _read(
        f"<w:p><w:r>{_picture('drawingImage')}</w:r></w:p>"
        f"<w:p><w:r>{_vml_picture('vmlImage')}</w:r></w:p>",
        **{
            "word/_rels/document.xml.rels": _relationships(
                ("drawingImage", "image", "media/drawing.png"),
                ("vmlImage", "image", "media/vml.png"),
            ),
            "word/media/drawing.png": "drawing-bytes",
            "word/media/vml.png": "vml-bytes",
        },
    )

    assert [image.node_locator for image in result.images] == ["word/document.xml#drawing[1]"]
    assert result.images[0].resource_part == "word/media/drawing.png"
    assert [
        (
            item.source_location,
            item.kind,
            item.relationship_id,
            item.related_part,
            item.parse_status,
        )
        for item in result.unsupported_records
    ] == [
        (
            "word/document.xml#pict[1]/imagedata",
            "vml_picture",
            "vmlImage",
            "word/media/vml.png",
            "unsupported",
        ),
    ]
    report = docx_read_result_to_report(result)
    assert report["reader_version"] == READER_VERSION == "s1-readonly-reader-1.5.0"
    assert len(report["images"]) == 1
    assert report["unsupported_records"][0]["kind"] == "vml_picture"


def test_vml_alternate_content_registers_only_the_selected_fallback() -> None:
    result = _read(
        "<w:p><mc:AlternateContent>"
        f'<mc:Choice Requires="unsupported">{_vml_picture("choiceImage")}</mc:Choice>'
        f"<mc:Fallback>{_vml_picture('fallbackImage')}</mc:Fallback>"
        "</mc:AlternateContent></w:p>",
        **{
            "word/_rels/document.xml.rels": _relationships(
                ("choiceImage", "image", "media/choice.png"),
                ("fallbackImage", "image", "media/fallback.png"),
            ),
            "word/media/choice.png": "choice-bytes",
            "word/media/fallback.png": "fallback-bytes",
        },
    )

    assert result.images == ()
    assert [
        (item.source_location, item.relationship_id, item.related_part)
        for item in result.unsupported_records
    ] == [
        (
            "word/document.xml#pict[1]/imagedata",
            "fallbackImage",
            "word/media/fallback.png",
        )
    ]


def test_duplicate_zip_members_are_rejected_instead_of_reading_one_twice() -> None:
    stream = BytesIO()
    with ZipFile(stream, "w") as archive:
        archive.writestr("word/document.xml", "first")
        with pytest.warns(UserWarning, match="Duplicate name"):
            archive.writestr("word/document.xml", "second")
    with pytest.raises(DocxReadError, match="duplicate ZIP part names"):
        read_docx_bytes(stream.getvalue(), source_label="duplicate-parts.docx")


@pytest.mark.parametrize("part_name", ["[Content_Types].xml", "word/document.xml"])
@pytest.mark.parametrize(
    "compression,flags,error,cause",
    [
        (99, 0, "Unsupported DOCX ZIP part storage", NotImplementedError),
        (0, 1, "Encrypted DOCX ZIP part", RuntimeError),
        (0, 64, "Encrypted DOCX ZIP part", NotImplementedError),
    ],
    ids=["unsupported-compression", "encrypted-entry", "strong-encryption"],
)
def test_unsupported_zip_entry_storage_is_a_typed_docx_refusal(
    part_name: str, compression: int, flags: int, error: str, cause: type[Exception]
) -> None:
    stream = BytesIO()
    with ZipFile(stream, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        )
        archive.writestr(
            "word/document.xml",
            f'<w:document xmlns:w="{WORD}"><w:body><w:p><w:r><w:t>Body</w:t>'
            "</w:r></w:p></w:body></w:document>",
        )
    payload = bytearray(stream.getvalue())
    with ZipFile(BytesIO(payload)) as archive:
        local_offset = archive.getinfo(part_name).header_offset
        central_offset = archive.start_dir
        for entry in archive.infolist():
            name_length, extra_length, comment_length = struct.unpack_from(
                "<HHH", payload, central_offset + 28
            )
            if entry.filename == part_name:
                break
            central_offset += 46 + name_length + extra_length + comment_length
    struct.pack_into("<HH", payload, local_offset + 6, flags, compression)
    struct.pack_into("<HH", payload, central_offset + 8, flags, compression)

    with pytest.raises(DocxReadError, match=error) as caught:
        read_docx_bytes(bytes(payload), source_label="unsupported-entry.docx")

    assert part_name in str(caught.value)
    assert isinstance(caught.value.__cause__, cause)


def test_text_projection_retains_tabs_and_line_breaks() -> None:
    result = _read(
        "<w:p><w:r><w:t>left</w:t><w:tab/><w:t>right</w:t><w:br/>"
        "<w:t>next</w:t><w:cr/><w:t>last</w:t></w:r></w:p>"
    )
    assert result.text_blocks[0].text == "left\tright\nnext\nlast"


def test_table_cell_projects_only_selected_alternate_branch_and_paragraph_boundaries() -> None:
    result = _read(
        '<w:tbl><w:tr><w:trPr><w:tblHeader w:val="false"/></w:trPr><w:tc><w:p>'
        '<mc:AlternateContent><mc:Choice Requires="unsupported"><w:r><w:t>Choice</w:t></w:r>'
        "</mc:Choice><mc:Fallback><w:r><w:t>Fallback</w:t></w:r></mc:Fallback>"
        "</mc:AlternateContent></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p>"
        "</w:tc></w:tr></w:tbl>"
    )
    assert result.tables[0].rows[0][0].text == "Fallback\nSecond"
    assert result.tables[0].repeat_header_rows == ()
    assert [block.text for block in result.text_blocks] == ["Fallback", "Second"]


def test_explicit_false_hidden_property_does_not_mark_text_hidden() -> None:
    result = _read('<w:p><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>shown</w:t></w:r></w:p>')
    assert not result.text_blocks[0].hidden


def test_complex_field_can_span_paragraphs() -> None:
    result = _read(
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>TOC</w:instrText>'
        '<w:fldChar w:fldCharType="separate"/><w:t>First</w:t></w:r></w:p>'
        '<w:p><w:r><w:t>Second</w:t><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
    assert len(result.fields) == 1
    assert result.fields[0].node_locator == "word/document.xml#paragraph[1]"
    assert result.fields[0].result_text == "First\nSecond"
    assert result.fields[0].boundary_sequence == ("begin", "separate", "end")
    assert not result.issues


def test_simple_fields_have_individual_source_occurrences_and_results() -> None:
    result = _read(
        '<w:p><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple>'
        '<w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>'
    )
    assert [item.occurrence_index for item in result.fields] == [1, 2]
    assert [item.result_text for item in result.fields] == ["1", "1"]
    assert all(item.boundary_sequence == ("simple",) for item in result.fields)
    assert result.text_blocks[0].contains_field_code


def test_nested_field_result_is_retained_in_enclosing_result() -> None:
    result = _read(
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>IF 1 = 1</w:instrText>'
        '<w:fldChar w:fldCharType="separate"/><w:t>See </w:t>'
        '<w:fldChar w:fldCharType="begin"/><w:instrText>REF target</w:instrText>'
        '<w:fldChar w:fldCharType="separate"/><w:t>3</w:t><w:fldChar w:fldCharType="end"/>'
        '<w:t> now</w:t><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
    assert [(item.field_kind, item.result_text) for item in result.fields] == [
        ("ref", "3"),
        ("if", "See 3 now"),
    ]


def test_nested_textbox_field_does_not_close_an_outer_story_field() -> None:
    result = _read(
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/><w:instrText>TOC</w:instrText>'
        '<w:fldChar w:fldCharType="separate"/><w:t>Body</w:t></w:r><w:txbxContent>'
        '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:txbxContent></w:p>'
        '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
    assert len(result.fields) == 1
    assert result.fields[0].boundary_sequence == ("begin", "separate", "end")
    assert result.issues == ("field-end-without-begin:word/document.xml#paragraph[2]",)


def test_paragraph_scopes_retain_empty_direct_body_and_nested_textbox_identity() -> None:
    result = _read(
        "<w:p/><w:p><w:txbxContent><w:p><w:r><w:t>Textbox</w:t><w:br/>"
        "</w:r></w:p></w:txbxContent></w:p><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr>"
        "</w:tbl><w:p/>"
    )
    assert [scope.body_paragraph_index for scope in result.paragraph_scopes] == [
        1,
        2,
        None,
        None,
        3,
    ]
    assert [scope.body_container_index for scope in result.paragraph_scopes] == [1, 2, 2, None, 3]
    assert [scope.region for scope in result.paragraph_scopes] == [
        "body",
        "body",
        "textbox",
        "body",
        "body",
    ]
    assert [scope.region_index for scope in result.paragraph_scopes] == [1, 2, 1, 3, 4]
    assert [item.node_locator for item in result.breaks] == [
        "word/document.xml#paragraph[3]/break[1]"
    ]


def test_objects_and_references_bind_to_exact_textbox_paragraph() -> None:
    result = _read(
        f"<w:p><w:txbxContent><w:p><w:r>{_picture()}</w:r><m:oMath><m:r><m:t>x</m:t>"
        '</m:r></m:oMath><w:bookmarkStart w:id="1" w:name="target"/></w:p>'
        "</w:txbxContent></w:p>",
        **{
            "word/_rels/document.xml.rels": _relationships(("image", "image", "media/picture.png")),
            "word/media/picture.png": "stored-image-bytes",
        },
    )
    assert result.images[0].paragraph_locator == "word/document.xml#paragraph[2]"
    assert result.math_objects[0].paragraph_locator == "word/document.xml#paragraph[2]"
    assert result.references[0].paragraph_locator == "word/document.xml#paragraph[2]"


def test_choice_object_metadata_and_physical_selected_parent_are_retained() -> None:
    result = _read(
        '<w:p><mc:AlternateContent><mc:Choice Requires="unsupported"><w:drawing><wp:inline>'
        '<wp:docPr id="5" name="chart" descr="RFW-CHART-MARKER"/>'
        '<a:graphic><a:graphicData><c:chart r:id="chart"/></a:graphicData></a:graphic>'
        "</wp:inline></w:drawing></mc:Choice><mc:Fallback><w:r><w:t>Preview</w:t></w:r>"
        "</mc:Fallback></mc:AlternateContent></w:p>",
        **{
            "word/_rels/document.xml.rels": _relationships(("chart", "chart", "charts/chart.xml")),
            "word/charts/chart.xml": f'<c:chart xmlns:c="{CHART}"/>',
        },
    )
    chart = result.complex_objects[0]
    assert chart.paragraph_locator == "word/document.xml#paragraph[1]"
    assert "RFW-CHART-MARKER" in dict(chart.metadata).values()
    assert chart.relationship_ids == ("chart",)


def test_choice_object_does_not_cross_an_unselected_inner_paragraph() -> None:
    result = _read(
        '<w:p><mc:AlternateContent><mc:Choice Requires="unsupported"><w:txbxContent><w:p>'
        '<w:drawing><wp:inline><a:graphic><a:graphicData><c:chart r:id="chart"/>'
        "</a:graphicData></a:graphic></wp:inline></w:drawing></w:p></w:txbxContent>"
        "</mc:Choice><mc:Fallback><w:r><w:t>Preview</w:t></w:r></mc:Fallback>"
        "</mc:AlternateContent></w:p>",
        **{
            "word/_rels/document.xml.rels": _relationships(("chart", "chart", "charts/chart.xml")),
            "word/charts/chart.xml": f'<c:chart xmlns:c="{CHART}"/>',
        },
    )
    assert result.complex_objects[0].paragraph_locator is None


def test_note_reference_with_no_relationship_is_partial_and_visible() -> None:
    result = _read('<w:p><w:r><w:footnoteReference w:id="2"/></w:r></w:p>')
    assert result.references[0].parse_status == "partial"
    assert result.references[0].target_part is None
    assert any(issue.startswith("reference-without-target:") for issue in result.issues)


def test_reference_does_not_take_an_unrelated_parts_note_relationship() -> None:
    result = _read(
        '<w:p><w:r><w:footnoteReference w:id="2"/></w:r></w:p>',
        **{
            "word/_rels/header1.xml.rels": _relationships(("notes", "footnotes", "footnotes.xml")),
            "word/footnotes.xml": f'<w:footnotes xmlns:w="{WORD}"/>',
        },
    )
    assert result.references[0].target_part is None
    assert result.references[0].parse_status == "partial"


def test_drawing_text_paragraphs_do_not_change_word_paragraph_identity() -> None:
    result = _read(
        "<w:p><w:r><w:t>Body</w:t><w:drawing><a:p><a:r><a:t>Drawing text</a:t>"
        "</a:r></a:p></w:drawing></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p>"
    )
    assert [scope.node_locator for scope in result.paragraph_scopes] == [
        "word/document.xml#paragraph[1]",
        "word/document.xml#paragraph[2]",
    ]
    assert [block.text for block in result.text_blocks] == ["Body", "Next"]
