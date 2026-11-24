"""Retained Word comment bodies resolve only from exact, selected definitions."""

from dataclasses import replace
from xml.etree import ElementTree

from research_file_workbench.docx.models import DocxCommentDetail, DocxReference, DocxRelationship
from research_file_workbench.docx.parsing.markup_compatibility import parse_docx_xml
from research_file_workbench.docx.parsing.references import read_comment_details
from research_file_workbench.docx.xml_support import OFFICE_RELATIONSHIP_NAMESPACE

COMMENTS_RELATIONSHIP = DocxRelationship(
    source_part="word/document.xml",
    relationship_id="rIdComments",
    relationship_type=f"{OFFICE_RELATIONSHIP_NAMESPACE}/comments",
    target="comments.xml",
    target_mode=None,
    resolved_target="word/comments.xml",
)

WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"


def _comments(*comments: str) -> dict[str, ElementTree.Element]:
    return {
        "word/comments.xml": parse_docx_xml(
            (
                f'<w:comments xmlns:w="{WORD}" xmlns:mc="{MC}">'
                + "".join(comments)
                + "</w:comments>"
            ).encode()
        )
    }


def _anchor(
    locator: str,
    reference_id: str | None,
    *,
    target_part: str | None = "word/comments.xml",
) -> DocxReference:
    return DocxReference(
        part_path="word/document.xml",
        node_locator=locator,
        kind="comment_anchor",
        reference_id=reference_id,
        reference_name=None,
        relationship_id="rIdComments",
        target_part=target_part,
        parse_status="parsed",
        limitations=(),
        paragraph_locator="word/document.xml#paragraph[1]",
    )


def test_comment_details_preserve_selected_text_and_paragraph_separators() -> None:
    roots = _comments(
        '<w:comment w:id="1" w:author="Ada Lovelace" w:date="2026-11-23T10:00:00Z">'
        "<w:p><w:r><w:t>First</w:t></w:r><w:r><w:tab/><w:t>Second</w:t></w:r>"
        "<w:r><w:br/><w:t>Third</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>Next</w:t></w:r></w:p></w:comment>",
        '<w:comment w:id="2"><w:p><w:r><w:t>Plain</w:t></w:r></w:p>'
        '<mc:AlternateContent><mc:Choice Requires="w">'
        "<w:p><w:r><w:t>Selected</w:t></w:r></w:p></mc:Choice>"
        "<mc:Fallback><w:p><w:r><w:t>Fallback</w:t></w:r></w:p></mc:Fallback>"
        "</mc:AlternateContent></w:comment>",
    )
    anchors = (
        _anchor("word/document.xml#reference[1]", "1"),
        _anchor("word/document.xml#reference[2]", "2"),
    )

    details = read_comment_details(roots, anchors, (COMMENTS_RELATIONSHIP,))

    assert details == {
        anchors[0].node_locator: DocxCommentDetail(
            text="First\tSecond\nThird\nNext",
            author="Ada Lovelace",
            date="2026-11-23T10:00:00Z",
            node_locator="word/comments.xml#comment[1]",
        ),
        anchors[1].node_locator: DocxCommentDetail(
            text="Plain\nSelected",
            author=None,
            date=None,
            node_locator="word/comments.xml#comment[2]",
        ),
    }


def test_empty_comment_is_present_while_unresolved_details_are_absent() -> None:
    roots = {
        **_comments(
            '<w:comment w:id="3"><w:p/></w:comment>',
            '<w:comment w:id="5"><w:p><w:r><w:t>One</w:t></w:r></w:p></w:comment>',
            '<w:comment w:id="5"><w:p><w:r><w:t>Two</w:t></w:r></w:p></w:comment>',
            '<w:comment w:id="7"><w:p><w:r><w:t>Numeric</w:t></w:r></w:p></w:comment>',
            "<w:comment><w:p><w:r><w:t>No id</w:t></w:r></w:p></w:comment>",
        ),
        "word/not-comments.xml": parse_docx_xml(
            b'<comments xmlns="urn:not-word"><comment id="7"/></comments>'
        ),
    }
    anchors = (
        _anchor("word/document.xml#reference[1]", "3"),
        _anchor("word/document.xml#reference[2]", "4"),
        _anchor("word/document.xml#reference[3]", "5"),
        _anchor("word/document.xml#reference[4]", "03"),
        _anchor("word/document.xml#reference[5]", None),
        _anchor("word/document.xml#reference[6]", "7", target_part="word/not-comments.xml"),
        _anchor("word/document.xml#reference[7]", "3", target_part="word/missing-comments.xml"),
    )

    details = read_comment_details(roots, anchors, (COMMENTS_RELATIONSHIP,))

    assert details == {
        anchors[0].node_locator: DocxCommentDetail(
            text="",
            author=None,
            date=None,
            node_locator="word/comments.xml#comment[1]",
        )
    }

    wrong_root_relationship = replace(
        COMMENTS_RELATIONSHIP,
        relationship_id="rIdSecondComments",
        target="not-comments.xml",
        resolved_target="word/not-comments.xml",
    )
    assert read_comment_details(roots, (anchors[5],), (wrong_root_relationship,)) == {}
    assert (
        read_comment_details(roots, anchors, (COMMENTS_RELATIONSHIP, wrong_root_relationship)) == {}
    )
