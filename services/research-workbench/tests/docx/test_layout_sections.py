"""Section bucketing edge cases for the body-format observation."""

import xml.etree.ElementTree as ET

from research_file_workbench.docx.parsing.layout import read_layout

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def document(body: str) -> dict[str, ET.Element]:
    return {
        "word/document.xml": ET.fromstring(
            f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'
        )
    }


def sect_pr(cols: str = "2") -> str:
    return f'<w:sectPr><w:pgSz w:w="11906" w:h="16839"/><w:cols w:num="{cols}"/></w:sectPr>'


def paragraph(text: str = "body", size: str = "18", *, extra: str = "") -> str:
    rpr = f'<w:rPr><w:sz w:val="{size}"/></w:rPr>' if size else ""
    return f"<w:p><w:pPr>{extra}</w:pPr><w:r>{rpr}<w:t>{text}</w:t></w:r></w:p>"


def test_paragraph_level_sectpr_closes_sections_in_order():
    sections, _, issues = read_layout(
        document(paragraph("first") + sect_pr() + paragraph("second") + sect_pr("1"))
    )
    assert issues == []
    assert [(s.section_index, s.columns, s.body_font_size_halfpoints) for s in sections] == [
        (1, 2, 18),
        (2, 1, 18),
    ]


def test_body_level_sectpr_closes_the_final_section():
    sections, _, _ = read_layout(document(paragraph("only") + sect_pr("1")))
    assert len(sections) == 1 and sections[0].attached_to == "body"
    assert sections[0].body_font_size_halfpoints == 18


def test_textbox_and_deleted_and_hidden_runs_never_dominate():
    ac_open = (
        "<mc:AlternateContent "
        'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">'
    )
    sections, _, _ = read_layout(
        document(
            paragraph("body")
            + "<w:p><w:r><w:t>plain</w:t></w:r>"
            + ac_open
            + '<mc:Choice Requires="wps">'
            + '<w:r><w:rPr><w:sz w:val="10"/></w:rPr><w:t>box</w:t></w:r>'
            + "</mc:Choice>"
            + "<mc:Fallback><w:pict>"
            + '<w:r><w:rPr><w:sz w:val="9"/></w:rPr></w:r>'
            + "</w:pict></mc:Fallback>"
            + "</mc:AlternateContent></w:p>"
            + paragraph("tail", extra="<w:rPr><w:del/></w:rPr>")
            + sect_pr()
        )
    )
    # Only the three plain body runs (18) count; choice/fallback/deleted runs are excluded.
    assert sections[0].body_font_size_halfpoints == 18


def test_hidden_run_is_excluded_from_the_dominant_size():
    hidden = '<w:p><w:r><w:rPr><w:vanish/><w:sz w:val="10"/></w:rPr><w:t>hidden</w:t></w:r></w:p>'
    sections, _, _ = read_layout(document(paragraph("visible") + hidden + sect_pr()))
    assert sections[0].body_font_size_halfpoints == 18


def test_empty_body_has_no_sections():
    sections, _, issues = read_layout(document(""))
    assert sections == () and issues == []


def test_mixed_exact_and_atleast_spacing_reports_unknown():
    sections, _, _ = read_layout(
        document(
            paragraph("a", extra='<w:spacing w:line="230" w:lineRule="exact"/>')
            + paragraph("b", extra='<w:spacing w:line="240" w:lineRule="atLeast"/>')
            + sect_pr()
        )
    )
    assert sections[0].body_line_spacing_twips is None


def test_exact_spacing_dominates_when_declared():
    sections, _, _ = read_layout(
        document(
            paragraph("a", extra='<w:spacing w:line="230" w:lineRule="exact"/>')
            + paragraph("b", extra='<w:spacing w:line="230" w:lineRule="exact"/>')
            + sect_pr()
        )
    )
    assert sections[0].body_line_spacing_twips == 230


def test_non_ascii_digit_values_are_refused_not_crashing():
    sections, _, issues = read_layout(
        document(
            '<w:p><w:r><w:rPr><w:sz w:val="\u00b2"/></w:rPr><w:t>x</w:t></w:r></w:p>' + sect_pr()
        )
    )
    assert sections[0].body_font_size_halfpoints is None and issues == []
