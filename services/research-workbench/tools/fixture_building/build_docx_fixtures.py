"""Build the seven deterministic Phase 0 DOCX fixtures from one entry point."""

from __future__ import annotations

import argparse
import binascii
import os
import random
import re
import struct
import tempfile
import zlib
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT, WD_SECTION
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.text import WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt
from fixture_manifest import (
    AnnotationObject,
    FixtureCase,
    FixtureRecord,
    write_annotation,
    write_catalog,
)
from generation_boundary import preflight_outputs
from markers import (
    ALL_FIXTURES,
    BROKEN_RELATIONSHIPS,
    EMBEDDED_OBJECTS,
    FIGURES_TABLES,
    MISSING_FONT,
    PAGINATION_AMBIGUITY,
    REGIONS_FIELDS,
    SECTIONS_LAYOUT,
    FixtureIdentity,
)
from package_mutations import (
    append_content_type_override,
    append_relationship,
    convert_drawing_to_anchor,
    mutate_package,
    replace_placeholder_paragraph,
    rewrite_package,
)

from research_file_workbench.common.filesystem import require_owned_output
from research_file_workbench.common.hashing import sha256_file

_FIXED_TIME = datetime(2026, 9, 24, 0, 0, tzinfo=UTC)
_MISSING_FONT_NAME = "RFW Fixture Missing Font 2026"
_WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_WINDOWS_FILE_PATH_LIMIT = 260
_WINDOWS_DIRECTORY_PATH_LIMIT = 248


def _case(
    case_id: str,
    implementation_status: str = "generated",
    expected_support: str = "required_structural_result",
    *limitations: str,
) -> FixtureCase:
    return FixtureCase(case_id, implementation_status, expected_support, limitations)


def _annotation(
    marker: str,
    kind: str,
    *,
    region: str = "body",
    support: str = "required_structural_result",
    status: str = "pending_review",
    limitations: tuple[str, ...] = (),
) -> AnnotationObject:
    return AnnotationObject(
        annotation_id=marker.lower(),
        region=region,
        kind=kind,
        locator=f"Visible marker or package locator: {marker}",
        expected_support=support,
        review_status=status,
        limitations=limitations,
    )


def _new_document(title: str) -> Document:
    random.seed(f"research-file-workbench:{title}")
    document = Document()
    document.core_properties.title = title
    document.core_properties.subject = "Research File Workbench Phase 0 fixture"
    document.core_properties.author = "Research File Workbench"
    document.core_properties.created = _FIXED_TIME
    document.core_properties.modified = _FIXED_TIME
    normal = document.styles["Normal"]
    normal.font.name = "Arial"
    normal.font.size = Pt(10)
    section = document.sections[0]
    section.top_margin = Inches(0.75)
    section.bottom_margin = Inches(0.75)
    section.left_margin = Inches(0.8)
    section.right_margin = Inches(0.8)
    document.add_heading(title, level=1)
    return document


def _save_canonical(document: Document, path: Path) -> None:
    require_owned_output(path, (path.parent,))
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.parent / "source.docx"
    require_owned_output(temporary_path, (path.parent,))
    document.save(temporary_path)
    rewrite_package(temporary_path, path)
    temporary_path.unlink()


def _png_bytes(width: int, height: int, rgb: tuple[int, int, int]) -> bytes:
    signature = b"\x89PNG\r\n\x1a\n"

    def chunk(kind: bytes, payload: bytes) -> bytes:
        checksum = binascii.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    scanline = b"\x00" + bytes(rgb) * width
    pixels = scanline * height
    return (
        signature
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(pixels, 9))
        + chunk(b"IEND", b"")
    )


def _append_text_run(parent: OxmlElement, text: str) -> None:
    run = OxmlElement("w:r")
    text_element = OxmlElement("w:t")
    text_element.text = text
    run.append(text_element)
    parent.append(run)


def _field_runs(instruction: str, result: str) -> list[OxmlElement]:
    begin_run = OxmlElement("w:r")
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    begin_run.append(begin)
    instruction_run = OxmlElement("w:r")
    instruction_text = OxmlElement("w:instrText")
    instruction_text.set(qn("xml:space"), "preserve")
    instruction_text.text = instruction
    instruction_run.append(instruction_text)
    separate_run = OxmlElement("w:r")
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    separate_run.append(separate)
    result_run = OxmlElement("w:r")
    result_text = OxmlElement("w:t")
    result_text.text = result
    result_run.append(result_text)
    end_run = OxmlElement("w:r")
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    end_run.append(end)
    return [begin_run, instruction_run, separate_run, result_run, end_run]


def _add_field(document: Document, marker: str, instruction: str, result: str) -> None:
    paragraph = document.add_paragraph(marker + " ")
    for element in _field_runs(instruction, result):
        paragraph._p.append(element)


def _add_repeat_table_header(row) -> None:
    properties = row._tr.get_or_add_trPr()
    repeat = OxmlElement("w:tblHeader")
    repeat.set(qn("w:val"), "true")
    properties.append(repeat)


def _set_columns(section, count: int) -> None:
    properties = section._sectPr
    columns = properties.find(qn("w:cols"))
    if columns is None:
        columns = OxmlElement("w:cols")
        properties.append(columns)
    columns.set(qn("w:num"), str(count))
    columns.set(qn("w:space"), "720")


def _set_portrait(section) -> None:
    section.orientation = WD_ORIENT.PORTRAIT
    page_size = section._sectPr.find(qn("w:pgSz"))
    if page_size is not None:
        page_size.attrib.pop(qn("w:orient"), None)


def _build_regions_fields(path: Path) -> FixtureRecord:
    identity = REGIONS_FIELDS
    document = _new_document("S1 regions and fields")
    body_marker = identity.marker("body")
    document.add_paragraph(f"{body_marker} ordinary body text.")
    header_marker = identity.marker("header")
    document.sections[0].header.paragraphs[0].text = header_marker
    footer_marker = identity.marker("footer")
    document.sections[0].footer.paragraphs[0].text = footer_marker

    textbox_marker = identity.marker("textbox")
    document.add_paragraph("__RFW_TEXTBOX_PLACEHOLDER__")
    footnote_reference = identity.marker("footnote-ref")
    document.add_paragraph("__RFW_FOOTNOTE_PLACEHOLDER__")
    endnote_reference = identity.marker("endnote-ref")
    document.add_paragraph("__RFW_ENDNOTE_PLACEHOLDER__")

    hidden_marker = identity.marker("hidden-text")
    hidden_run = document.add_paragraph().add_run(hidden_marker)
    hidden_run.font.hidden = True

    revision_marker = identity.marker("revision")
    document.add_paragraph("__RFW_REVISION_PLACEHOLDER__")
    comment_marker = identity.marker("comment-anchor")
    comment_run = document.add_paragraph().add_run(comment_marker)
    comment = document.add_comment(comment_run, text=identity.marker("comment-body"), author="RFW")
    comment.date = _FIXED_TIME

    inline_marker = identity.marker("inline-omml")
    document.add_paragraph("__RFW_INLINE_OMML_PLACEHOLDER__")
    display_marker = identity.marker("display-omml")
    document.add_paragraph("__RFW_DISPLAY_OMML_PLACEHOLDER__")

    nested_marker = identity.marker("nested-field")
    document.add_paragraph("__RFW_NESTED_FIELD_PLACEHOLDER__")
    zotero_marker = identity.marker("zotero-field")
    _add_field(
        document,
        zotero_marker,
        ' ADDIN ZOTERO_ITEM CSL_CITATION {"citationItems":[{"id":1}]} ',
        "[Fixture Citation]",
    )
    xref_target = identity.marker("xref-target")
    target_paragraph = document.add_paragraph(xref_target)
    bookmark_start = OxmlElement("w:bookmarkStart")
    bookmark_start.set(qn("w:id"), "42")
    bookmark_start.set(qn("w:name"), "RFW_XREF_TARGET_001")
    target_paragraph._p.insert(0, bookmark_start)
    bookmark_end = OxmlElement("w:bookmarkEnd")
    bookmark_end.set(qn("w:id"), "42")
    target_paragraph._p.append(bookmark_end)
    xref_marker = identity.marker("xref-result")
    _add_field(document, xref_marker, " REF RFW_XREF_TARGET_001 \\h ", xref_target)
    external_marker = identity.marker("external-link")
    document.add_paragraph("__RFW_EXTERNAL_LINK_PLACEHOLDER__")
    _save_canonical(document, path)

    def inject_structures(parts: dict[str, bytes]) -> None:
        comments_xml = parts["word/comments.xml"].decode("utf-8")
        comments_xml, replacement_count = re.subn(
            r' w:date="[^"]+"',
            ' w:date="2026-09-24T00:00:00Z"',
            comments_xml,
            count=1,
        )
        if replacement_count != 1:
            raise RuntimeError("Expected exactly one generated comment date")
        parts["word/comments.xml"] = comments_xml.encode("utf-8")
        document_xml = parts["word/document.xml"].decode("utf-8")
        textbox_xml = (
            f'<w:r><w:t>{textbox_marker} </w:t><w:pict xmlns:v="urn:schemas-microsoft-com:vml">'
            '<v:shape id="RFWTextBox001" style="width:220pt;height:40pt" type="#_x0000_t202">'
            "<v:textbox><w:txbxContent><w:p><w:r><w:t>"
            f"{textbox_marker} text box content"
            "</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r>"
        )
        document_xml = replace_placeholder_paragraph(
            document_xml, "__RFW_TEXTBOX_PLACEHOLDER__", textbox_xml
        )
        footnote_xml = (
            f'<w:r><w:t>{footnote_reference} </w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r>'
        )
        document_xml = replace_placeholder_paragraph(
            document_xml, "__RFW_FOOTNOTE_PLACEHOLDER__", footnote_xml
        )
        endnote_xml = (
            f'<w:r><w:t>{endnote_reference} </w:t></w:r><w:r><w:endnoteReference w:id="2"/></w:r>'
        )
        document_xml = replace_placeholder_paragraph(
            document_xml, "__RFW_ENDNOTE_PLACEHOLDER__", endnote_xml
        )
        revision_xml = (
            f"<w:r><w:t>{revision_marker} </w:t></w:r>"
            '<w:del w:id="100" w:author="RFW" w:date="2026-09-24T00:00:00Z">'
            f"<w:r><w:delText>{identity.marker('revision-deleted')}</w:delText></w:r></w:del>"
            '<w:ins w:id="101" w:author="RFW" w:date="2026-09-24T00:00:00Z">'
            f"<w:r><w:t>{identity.marker('revision-inserted')}</w:t></w:r></w:ins>"
        )
        document_xml = replace_placeholder_paragraph(
            document_xml, "__RFW_REVISION_PLACEHOLDER__", revision_xml
        )
        inline_omml = (
            f"<w:r><w:t>{inline_marker} </w:t></w:r>"
            '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
            "<m:r><m:t>x+1</m:t></m:r></m:oMath>"
        )
        document_xml = replace_placeholder_paragraph(
            document_xml, "__RFW_INLINE_OMML_PLACEHOLDER__", inline_omml
        )
        display_omml = (
            f"<w:r><w:t>{display_marker} </w:t></w:r>"
            '<m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">'
            "<m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num>"
            "<m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></m:oMathPara>"
        )
        document_xml = replace_placeholder_paragraph(
            document_xml, "__RFW_DISPLAY_OMML_PLACEHOLDER__", display_omml
        )
        nested_field_xml = (
            f"<w:r><w:t>{nested_marker} </w:t></w:r>"
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            '<w:r><w:instrText xml:space="preserve"> IF </w:instrText></w:r>'
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            '<w:r><w:instrText xml:space="preserve"> MERGEFIELD RFW_VALUE </w:instrText></w:r>'
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
            "<w:r><w:t>1</w:t></w:r>"
            '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
            '<w:r><w:instrText xml:space="preserve">'
            ' = 1 "nested result" "other" </w:instrText></w:r>'
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
            "<w:r><w:t>nested result</w:t></w:r>"
            '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
        )
        document_xml = replace_placeholder_paragraph(
            document_xml, "__RFW_NESTED_FIELD_PLACEHOLDER__", nested_field_xml
        )
        external_link = (
            f"<w:r><w:t>{external_marker} </w:t></w:r>"
            '<w:hyperlink r:id="rIdRfwExternal001">'
            "<w:r><w:t>external target</w:t></w:r></w:hyperlink>"
        )
        document_xml = replace_placeholder_paragraph(
            document_xml, "__RFW_EXTERNAL_LINK_PLACEHOLDER__", external_link
        )
        parts["word/document.xml"] = document_xml.encode("utf-8")
        rels_xml = parts["word/_rels/document.xml.rels"].decode("utf-8")
        rels_xml = append_relationship(
            rels_xml,
            '<Relationship Id="rIdRfwFootnotes" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" '
            'Target="footnotes.xml"/>',
        )
        rels_xml = append_relationship(
            rels_xml,
            '<Relationship Id="rIdRfwEndnotes" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" '
            'Target="endnotes.xml"/>',
        )
        rels_xml = append_relationship(
            rels_xml,
            '<Relationship Id="rIdRfwExternal001" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
            'Target="https://example.invalid/rfw-fixture/external-target-001" '
            'TargetMode="External"/>',
        )
        parts["word/_rels/document.xml.rels"] = rels_xml.encode("utf-8")
        content_types = parts["[Content_Types].xml"].decode("utf-8")
        content_types = append_content_type_override(
            content_types,
            '<Override PartName="/word/footnotes.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>',
        )
        content_types = append_content_type_override(
            content_types,
            '<Override PartName="/word/endnotes.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>',
        )
        parts["[Content_Types].xml"] = content_types.encode("utf-8")
        parts["word/footnotes.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<w:footnotes xmlns:w="{_WORD_NS}">'
            '<w:footnote w:type="separator" w:id="-1">'
            "<w:p><w:r><w:separator/></w:r></w:p></w:footnote>"
            '<w:footnote w:type="continuationSeparator" w:id="0">'
            "<w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>"
            '<w:footnote w:id="2"><w:p><w:r><w:t>'
            f"{identity.marker('footnote-body')}"
            "</w:t></w:r></w:p></w:footnote>"
            "</w:footnotes>"
        ).encode()
        parts["word/endnotes.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<w:endnotes xmlns:w="{_WORD_NS}">'
            '<w:endnote w:type="separator" w:id="-1">'
            "<w:p><w:r><w:separator/></w:r></w:p></w:endnote>"
            '<w:endnote w:type="continuationSeparator" w:id="0">'
            "<w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>"
            '<w:endnote w:id="2"><w:p><w:r><w:t>'
            f"{identity.marker('endnote-body')}"
            "</w:t></w:r></w:p></w:endnote>"
            "</w:endnotes>"
        ).encode()

    mutate_package(path, inject_structures)
    markers_and_kinds = (
        (body_marker, "paragraph", "body"),
        (textbox_marker, "textbox", "textbox"),
        (header_marker, "header", "header"),
        (footer_marker, "footer", "footer"),
        (footnote_reference, "footnote_reference", "body"),
        (identity.marker("footnote-body"), "footnote", "footnote"),
        (endnote_reference, "endnote_reference", "body"),
        (identity.marker("endnote-body"), "endnote", "endnote"),
        (hidden_marker, "hidden_text", "body"),
        (revision_marker, "revision", "body"),
        (comment_marker, "comment_anchor", "body"),
        (inline_marker, "inline_equation", "body"),
        (display_marker, "display_equation", "body"),
        (nested_marker, "nested_field", "body"),
        (zotero_marker, "zotero_field", "body"),
        (xref_marker, "cross_reference", "body"),
        (external_marker, "external_target", "body"),
    )
    return FixtureRecord(
        identity=identity,
        artifact_id="fixture-docx-s1-regions-fields",
        group_id="regions-and-text+equations-and-fields",
        cases=tuple(
            _case(case_id)
            for case_id in (
                "body",
                "textbox",
                "header",
                "footer",
                "footnote",
                "endnote",
                "hidden_text",
                "revision",
                "comment",
                "inline_omml",
                "display_omml",
                "nested_field",
                "zotero_field",
                "cross_reference",
                "external_target",
            )
        ),
        objects=tuple(
            _annotation(marker, kind, region=region) for marker, kind, region in markers_and_kinds
        ),
    )


def _build_sections_layout(path: Path) -> FixtureRecord:
    identity = SECTIONS_LAYOUT
    document = _new_document("S1 sections and layout")
    first = document.sections[0]
    first.page_width = Inches(8.27)
    first.page_height = Inches(11.69)
    document.add_paragraph(identity.marker("section-a4-portrait"))

    letter = document.add_section(WD_SECTION.NEW_PAGE)
    letter.page_width = Inches(8.5)
    letter.page_height = Inches(11)
    document.add_paragraph(identity.marker("section-letter-portrait", 2))

    landscape = document.add_section(WD_SECTION.NEW_PAGE)
    landscape.orientation = WD_ORIENT.LANDSCAPE
    landscape.page_width = Inches(11.69)
    landscape.page_height = Inches(8.27)
    document.add_paragraph(identity.marker("section-a4-landscape", 3))

    two_column = document.add_section(WD_SECTION.NEW_PAGE)
    _set_portrait(two_column)
    two_column.page_width = Inches(8.27)
    two_column.page_height = Inches(11.69)
    _set_columns(two_column, 2)
    document.add_paragraph(identity.marker("section-a4-two-column", 4))
    document.add_paragraph(identity.marker("column-break-before"))
    document.paragraphs[-1].add_run().add_break(WD_BREAK.COLUMN)
    document.add_paragraph(identity.marker("column-break-after"))

    restored = document.add_section(WD_SECTION.NEW_PAGE)
    _set_portrait(restored)
    restored.page_width = Inches(8.27)
    restored.page_height = Inches(11.69)
    _set_columns(restored, 1)
    document.add_paragraph(identity.marker("section-a4-restored", 5))
    document.add_paragraph(identity.marker("page-break-before"))
    document.paragraphs[-1].add_run().add_break(WD_BREAK.PAGE)
    document.add_paragraph(identity.marker("page-break-after"))

    base = document.styles.add_style("RFW Fixture Base", WD_STYLE_TYPE.PARAGRAPH)
    base.base_style = document.styles["Normal"]
    base.font.name = "Arial"
    base.font.size = Pt(11)
    base.paragraph_format.space_after = Pt(8)
    child = document.styles.add_style("RFW Fixture Child", WD_STYLE_TYPE.PARAGRAPH)
    child.base_style = base
    child.font.italic = True
    document.add_paragraph(identity.marker("style-inheritance"), style=child)
    for index in range(1, 4):
        document.add_paragraph(
            f"{identity.marker('numbering', index)} numbered item", style="List Number"
        )
    _save_canonical(document, path)
    markers = (
        identity.marker("section-a4-portrait"),
        identity.marker("section-letter-portrait", 2),
        identity.marker("section-a4-landscape", 3),
        identity.marker("section-a4-two-column", 4),
        identity.marker("section-a4-restored", 5),
        identity.marker("column-break-before"),
        identity.marker("page-break-before"),
        identity.marker("style-inheritance"),
        identity.marker("numbering", 1),
    )
    return FixtureRecord(
        identity=identity,
        artifact_id="fixture-docx-s1-sections-layout",
        group_id="pages-and-formatting",
        cases=tuple(
            _case(item)
            for item in (
                "a4",
                "other_page_size",
                "portrait_landscape",
                "section",
                "two_column",
                "page_break",
                "column_break",
                "style_inheritance",
                "numbering",
            )
        ),
        objects=tuple(_annotation(marker, "layout_marker") for marker in markers),
    )


def _build_figures_tables(path: Path, working_directory: Path) -> FixtureRecord:
    identity = FIGURES_TABLES
    document = _new_document("S1 figures and tables")
    image_path = working_directory / "fixture-image.png"
    image_path.write_bytes(_png_bytes(240, 120, (36, 99, 160)))
    inline_marker = identity.marker("inline-image")
    paragraph = document.add_paragraph(inline_marker + " ")
    paragraph.add_run().add_picture(str(image_path), width=Inches(2.0))
    document.add_paragraph(identity.marker("figure-caption"), style="Caption")

    floating_marker = identity.marker("floating-image")
    paragraph = document.add_paragraph(floating_marker + " ")
    paragraph.add_run().add_picture(str(image_path), width=Inches(2.0))
    document.add_paragraph(
        f"{identity.marker('float-anchor')} surrounding text for square wrap verification."
    )

    table_caption = identity.marker("table-caption")
    document.add_paragraph(table_caption, style="Caption")
    table = document.add_table(rows=1, cols=3)
    table.style = "Table Grid"
    header = table.rows[0]
    _add_repeat_table_header(header)
    for column, value in enumerate((identity.marker("table-header"), "Value", "Notes")):
        header.cells[column].text = value
    for index in range(1, 56):
        cells = table.add_row().cells
        cells[0].text = identity.marker("table-row", index)
        cells[1].text = str(index)
        cells[2].text = "Multipage table fixture row with stable content."

    merged = document.add_table(rows=2, cols=3)
    merged.style = "Table Grid"
    merged.cell(0, 0).merge(merged.cell(0, 1)).text = identity.marker("merged-cell")
    merged.cell(1, 0).text = "vertical merge start"
    merged.cell(1, 1).text = "independent cell"
    merged.cell(1, 2).text = "independent cell"
    _save_canonical(document, path)

    def float_image(parts: dict[str, bytes]) -> None:
        document_xml = parts["word/document.xml"].decode("utf-8")
        parts["word/document.xml"] = convert_drawing_to_anchor(
            document_xml, floating_marker
        ).encode("utf-8")

    mutate_package(path, float_image)
    markers = (
        (inline_marker, "inline_drawing"),
        (floating_marker, "anchored_drawing"),
        (identity.marker("table-header"), "repeated_header"),
        (identity.marker("table-row", 1), "multi_page_table"),
        (identity.marker("merged-cell"), "merged_cell"),
    )
    caption_limitation = (
        "Uses the native Caption paragraph style without a SEQ field; automatic numbering is not "
        "claimed and remains pending independent review.",
    )
    return FixtureRecord(
        identity=identity,
        artifact_id="fixture-docx-s1-figures-tables",
        group_id="figures-and-tables",
        cases=tuple(
            _case(item)
            for item in (
                "inline_drawing",
                "floating_figure",
                "text_wrap",
                "multi_page_table",
                "merged_cell",
                "repeated_header",
            )
        )
        + (
            _case(
                "caption",
                "generated",
                "required_structural_result",
                "Caption paragraphs use the native Caption style but do not contain a SEQ field; "
                "automatic numbering remains pending independent review.",
            ),
        ),
        objects=tuple(_annotation(marker, kind) for marker, kind in markers)
        + (
            _annotation(
                identity.marker("figure-caption"),
                "caption",
                limitations=caption_limitation,
            ),
            _annotation(table_caption, "caption", limitations=caption_limitation),
        ),
    )


def _build_embedded_objects(path: Path) -> FixtureRecord:
    identity = EMBEDDED_OBJECTS
    document = _new_document("S1 embedded and unknown objects")
    unknown_marker = identity.marker("unknown-extension-anchor")
    document.add_paragraph("__RFW_UNKNOWN_NAMESPACE_PLACEHOLDER__")
    document.add_paragraph(
        "This fixture intentionally does not fake chart, OLE, or grouped drawing objects. "
        "Their cases remain explicitly unsupported pending a verified native generation path."
    )
    _save_canonical(document, path)

    def inject_unknown_parts(parts: dict[str, bytes]) -> None:
        document_xml = parts["word/document.xml"].decode("utf-8")
        unknown_xml = (
            f"<w:r><w:t>{unknown_marker} </w:t></w:r>"
            "<mc:AlternateContent "
            'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
            'xmlns:rfw="urn:research-file-workbench:fixture:unknown:2026">'
            '<mc:Choice Requires="rfw">'
            '<rfw:unknownObject rfw:id="RFW-FX-EO-UNKNOWN-EXTENSION-001"/>'
            "</mc:Choice>"
            "<mc:Fallback><w:r><w:t>unknown extension fallback</w:t></w:r></mc:Fallback>"
            "</mc:AlternateContent>"
        )
        document_xml = replace_placeholder_paragraph(
            document_xml, "__RFW_UNKNOWN_NAMESPACE_PLACEHOLDER__", unknown_xml
        )
        parts["word/document.xml"] = document_xml.encode("utf-8")
        parts["customXml/item1.xml"] = (
            b'<?xml version="1.0" encoding="UTF-8"?>'
            b'<rfw:fixture xmlns:rfw="urn:research-file-workbench:fixture:custom-xml:2026" '
            b'id="RFW-FX-EO-UNKNOWN-EXTENSION-001"/>'
        )

    mutate_package(path, inject_unknown_parts)
    unsupported_limitation = (
        "No verified native generator is available in Phase 0; "
        "no text placeholder is counted as the object.",
    )
    objects = (
        _annotation(unknown_marker, "unknown_extension", support="register_and_render"),
        _annotation(
            "package:customXml/item1.xml",
            "unknown_namespace",
            support="register_and_render",
        ),
        _annotation(
            "not-generated:embedded-chart",
            "embedded_chart",
            support="declared_unsupported",
            status="unsupported",
            limitations=unsupported_limitation,
        ),
        _annotation(
            "not-generated:ole-object",
            "ole",
            support="declared_unsupported",
            status="unsupported",
            limitations=unsupported_limitation,
        ),
        _annotation(
            "not-generated:group-drawing",
            "group_drawing",
            support="declared_unsupported",
            status="unsupported",
            limitations=unsupported_limitation,
        ),
    )
    return FixtureRecord(
        identity=identity,
        artifact_id="fixture-docx-s1-embedded-objects",
        group_id="complex-and-unknown",
        cases=(
            _case("unknown_extension", "generated", "register_and_render"),
            _case("unknown_namespace", "generated", "register_and_render"),
            _case(
                "embedded_chart",
                "unsupported",
                "declared_unsupported",
                *unsupported_limitation,
            ),
            _case("ole", "unsupported", "declared_unsupported", *unsupported_limitation),
            _case(
                "group_drawing",
                "unsupported",
                "declared_unsupported",
                *unsupported_limitation,
            ),
        ),
        objects=objects,
        generation_status="partial",
        limitations=unsupported_limitation,
    )


def _build_broken_relationships(path: Path) -> FixtureRecord:
    identity = BROKEN_RELATIONSHIPS
    document = _new_document("S1 broken relationships")
    missing_rid = identity.marker("missing-rid")
    missing_target = identity.marker("missing-target")
    missing_external = identity.marker("missing-external")
    document.add_paragraph("__RFW_MISSING_RID_PLACEHOLDER__")
    document.add_paragraph(missing_target)
    document.add_paragraph("__RFW_MISSING_EXTERNAL_PLACEHOLDER__")
    _save_canonical(document, path)

    def inject_faults(parts: dict[str, bytes]) -> None:
        document_xml = parts["word/document.xml"].decode("utf-8")
        missing_rid_xml = (
            f"<w:r><w:t>{missing_rid} </w:t></w:r>"
            '<w:hyperlink r:id="rIdRfwMissingRelationship">'
            "<w:r><w:t>missing relationship</w:t></w:r></w:hyperlink>"
        )
        document_xml = replace_placeholder_paragraph(
            document_xml, "__RFW_MISSING_RID_PLACEHOLDER__", missing_rid_xml
        )
        missing_external_xml = (
            '<w:hyperlink r:id="rIdRfwMissingExternalDependency">'
            f"<w:r><w:t>{missing_external}</w:t></w:r></w:hyperlink>"
        )
        document_xml = replace_placeholder_paragraph(
            document_xml,
            "__RFW_MISSING_EXTERNAL_PLACEHOLDER__",
            missing_external_xml,
        )
        body_close = "</w:body>"
        document_xml = document_xml.replace(
            body_close,
            '<w:altChunk r:id="rIdRfwMissingInternalTarget"/>' + body_close,
            1,
        )
        parts["word/document.xml"] = document_xml.encode("utf-8")
        rels_xml = parts["word/_rels/document.xml.rels"].decode("utf-8")
        rels_xml = append_relationship(
            rels_xml,
            '<Relationship Id="rIdRfwMissingInternalTarget" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" '
            'Target="missing-fragment.html"/>',
        )
        rels_xml = append_relationship(
            rels_xml,
            '<Relationship Id="rIdRfwMissingExternalDependency" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
            'Target="https://example.invalid/rfw-fixture/missing-external-dependency" '
            'TargetMode="External"/>',
        )
        parts["word/_rels/document.xml.rels"] = rels_xml.encode("utf-8")

    mutate_package(path, inject_faults)
    return FixtureRecord(
        identity=identity,
        artifact_id="fixture-docx-s1-broken-relationships",
        group_id="complex-and-unknown+failure-and-access",
        cases=(
            _case("missing_relationship", "generated", "declared_unsupported"),
            _case("missing_internal_target", "generated", "declared_unsupported"),
            _case("missing_external_dependency", "generated", "declared_unsupported"),
        ),
        objects=(
            _annotation(missing_rid, "broken_relationship", support="declared_unsupported"),
            _annotation(missing_target, "missing_internal_target", support="declared_unsupported"),
            _annotation(
                missing_external, "missing_external_dependency", support="declared_unsupported"
            ),
        ),
        limitations=("This intentionally broken DOCX is not a stable page-render baseline.",),
    )


def _build_missing_font(path: Path) -> FixtureRecord:
    identity = MISSING_FONT
    document = _new_document("S1 missing font")
    control_marker = identity.marker("control")
    missing_marker = identity.marker("missing")
    control = document.add_paragraph().add_run(f"{control_marker} ABC xyz 012345")
    control.font.name = "Arial"
    missing = document.add_paragraph().add_run(f"{missing_marker} ABC xyz 012345")
    missing.font.name = _MISSING_FONT_NAME
    missing._element.rPr.rFonts.set(qn("w:eastAsia"), _MISSING_FONT_NAME)
    _save_canonical(document, path)
    return FixtureRecord(
        identity=identity,
        artifact_id="fixture-docx-s1-missing-font",
        group_id="failure-and-access",
        cases=(_case("missing_font", "generated", "explicit_partial_or_failure"),),
        objects=(
            _annotation(control_marker, "font_control"),
            _annotation(
                missing_marker,
                "missing_font",
                support="register_and_render",
                limitations=(
                    f"Requires environment inventory to confirm {_MISSING_FONT_NAME!r} is absent.",
                ),
            ),
        ),
    )


def _build_pagination_ambiguity(path: Path) -> FixtureRecord:
    identity = PAGINATION_AMBIGUITY
    document = _new_document("S1 pagination and ambiguity")
    duplicate_text = "RFW-FX-PA-DUPLICATE-TEXT"
    document.sections[0].header.paragraphs[0].text = duplicate_text
    filler = (
        "This deterministic paragraph contains enough prose to create natural pagination while "
        "preserving stable structural anchors. Page placement must come from a pinned render. "
    )
    duplicate_indexes = {45: "A", 235: "B"}
    for index in range(1, 321):
        anchor = f"RFW-FX-PA-P{index:04d}"
        if index in duplicate_indexes:
            label = duplicate_indexes[index]
            document.add_paragraph(identity.marker(f"dup-{label}-before"))
            document.add_paragraph(duplicate_text)
            document.add_paragraph(identity.marker(f"dup-{label}-after"))
        paragraph = document.add_paragraph(f"{anchor} {filler}")
        paragraph.paragraph_format.space_after = Pt(3)
        paragraph.paragraph_format.line_spacing = 1.05
    _save_canonical(document, path)
    return FixtureRecord(
        identity=identity,
        artifact_id="fixture-docx-s1-pagination-ambiguity",
        group_id="failure-and-access",
        cases=(
            _case("long_document_pagination", "generated", "required_structural_result"),
            _case("duplicate_text_mapping", "generated", "required_structural_result"),
        ),
        objects=(
            _annotation("RFW-FX-PA-P0001", "pagination_anchor"),
            _annotation("RFW-FX-PA-P0320", "pagination_anchor"),
            _annotation(duplicate_text, "duplicate_text"),
            _annotation(identity.marker("dup-A-before"), "adjacent_anchor"),
            _annotation(identity.marker("dup-B-before"), "adjacent_anchor"),
        ),
        limitations=("Expected page count remains pending a pinned WPS render.",),
    )


def build_fixtures(project_root: Path) -> tuple[FixtureRecord, ...]:
    """Generate a fresh batch without replacing fixtures or independent review evidence."""
    relative_outputs = (
        *(Path("tests/fixtures/docx") / item.relative_path for item in ALL_FIXTURES),
        *(
            Path("annotations/s1") / item.sample_id / filename
            for item in ALL_FIXTURES
            for filename in ("document-annotation.json", "page-evidence.json")
        ),
        Path("contracts/phase0/docx-fixture-catalog.json"),
    )
    outputs = tuple(project_root / relative for relative in relative_outputs)
    if os.name == "nt":
        for output in outputs:
            absolute = output.absolute()
            if (
                len(str(absolute).encode("utf-16-le")) // 2 >= _WINDOWS_FILE_PATH_LIMIT
                or len(str(absolute.parent).encode("utf-16-le")) // 2
                >= _WINDOWS_DIRECTORY_PATH_LIMIT
            ):
                raise ValueError(
                    "Fixture output path exceeds the supported Windows path length; "
                    f"choose a shorter generation root: {output}"
                )
    preflight_outputs(project_root, outputs)
    disposable_root = project_root / "var"
    require_owned_output(disposable_root, (project_root,), allow_existing=True)
    disposable_root.mkdir(parents=True, exist_ok=True)
    builders: tuple[tuple[FixtureIdentity, Callable[[Path], FixtureRecord]], ...]
    # Staging uses fewer characters than the final layout, including package mutation suffixes.
    with tempfile.TemporaryDirectory(prefix="", dir=disposable_root) as temporary_name:
        temporary_root = Path(temporary_name)
        fixture_root = temporary_root
        annotation_root = temporary_root / "a"
        catalog_path = temporary_root / "catalog.json"
        builders = (
            (REGIONS_FIELDS, _build_regions_fields),
            (SECTIONS_LAYOUT, _build_sections_layout),
            (
                FIGURES_TABLES,
                lambda output: _build_figures_tables(output, temporary_root),
            ),
            (EMBEDDED_OBJECTS, _build_embedded_objects),
            (BROKEN_RELATIONSHIPS, _build_broken_relationships),
            (MISSING_FONT, _build_missing_font),
            (PAGINATION_AMBIGUITY, _build_pagination_ambiguity),
        )
        records = []
        for identity, builder in builders:
            temporary_fixture = fixture_root / identity.relative_path
            record = builder(temporary_fixture)
            records.append(record)
        generated_records = tuple(records)
        for record in generated_records:
            fixture_path = fixture_root / record.identity.relative_path
            write_annotation(annotation_root, record, sha256_file(fixture_path))
        write_catalog(catalog_path, fixture_root, generated_records)
        staged_outputs = (
            *(fixture_root / item.relative_path for item in ALL_FIXTURES),
            *(
                annotation_root / item.sample_id / filename
                for item in ALL_FIXTURES
                for filename in ("document-annotation.json", "page-evidence.json")
            ),
            catalog_path,
        )
        preflight_outputs(project_root, outputs)
        for staged, output in zip(staged_outputs, outputs, strict=True):
            output.parent.mkdir(parents=True, exist_ok=True)
            # Exclusive creation also protects a target created after batch preflight.
            with output.open("xb") as destination:
                destination.write(staged.read_bytes())
    return generated_records


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project-root",
        type=Path,
        required=True,
        help="Explicit generation root for a fresh batch; existing output files are refused.",
    )
    return parser.parse_args()


def main() -> int:
    arguments = _parse_arguments()
    project_root = arguments.project_root
    records = build_fixtures(project_root)
    print(f"Built {len(records)} DOCX fixtures under {project_root / 'tests/fixtures/docx'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
