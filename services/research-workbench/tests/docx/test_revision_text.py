"""Accepted text is a separate observation, not a rewrite of XML or source evidence."""

from research_file_workbench.docx.query import ReadQuery, object_observations, query_docx
from tests.docx.test_reader_boundaries import _read


def _items(result, object_type):
    return query_docx(
        result,
        ReadQuery(object_type=object_type),
        task_id="revisions",
        actor_id="test",
        client_id="test",
    )["items"]


def test_inline_revision_text_retains_insertions_moved_to_text_and_surviving_separators():
    result = _read(
        '<w:p><w:r><w:t xml:space="preserve">Start </w:t></w:r>'
        '<w:ins w:id="1"><w:r><w:t>New</w:t></w:r>'
        '<w:del w:id="2"><w:r><w:delText> Nested old</w:delText><w:br/></w:r></w:del></w:ins>'
        '<w:moveFromRangeStart w:id="11"/>'
        '<w:moveFrom w:id="3"><w:r><w:delText>Moved away</w:delText></w:r></w:moveFrom>'
        '<w:moveFromRangeEnd w:id="11"/>'
        '<w:moveToRangeStart w:id="12"/>'
        '<w:moveTo w:id="4"><w:r><w:tab/><w:t>Moved here</w:t></w:r></w:moveTo>'
        '<w:moveToRangeEnd w:id="12"/>'
        '<mc:AlternateContent><mc:Choice Requires="w">'
        "<w:r><w:t> chosen</w:t></w:r></mc:Choice>"
        "<mc:Fallback><w:r><w:t> fallback</w:t></w:r></mc:Fallback></mc:AlternateContent>"
        '</w:p><w:p><w:del w:id="5"><w:r><w:delText>Gone</w:delText></w:r></w:del></w:p>'
        "<w:p><w:r><w:t>Unchanged</w:t></w:r></w:p>"
    )

    mixed, deleted, unchanged = _items(result, "text_block")
    old = "Start New Nested old\nMoved away\tMoved here chosen"
    assert mixed["content"]["text"] == "Start New\tMoved here chosen"
    assert mixed["content"]["source_text"] == old
    assert mixed["content"]["text_projection"] == "accepted_revisions"
    assert mixed["content"]["revision_state"] == "mixed"
    assert (deleted["content"]["text"], deleted["content"]["source_text"]) == ("", "Gone")
    assert deleted["content"]["text_projection"] == "accepted_revisions"
    assert unchanged["content"]["text"] == "Unchanged"
    assert "source_text" not in unchanged["content"]

    structural = next(
        item for item in object_observations(result) if item["object_type"] == "text_block"
    )
    assert structural["content"]["text"] == old
    assert "text_projection" not in structural["content"]
    for field in ("object_id", "part_path", "node_locator", "range_locator"):
        assert structural[field] == mixed[field]
    for field in ("byte_start", "byte_end"):
        assert structural["content"][field] == mixed["content"][field]


def test_structural_marks_and_unselected_compatibility_branches_have_distinct_limits():
    result = _read(
        '<w:p><w:pPr><w:rPr><w:del w:id="6"/></w:rPr></w:pPr>'
        "<w:r><w:t>Before paragraph merge</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>After paragraph merge</w:t></w:r></w:p>"
        '<w:tbl><w:tr><w:trPr><w:del w:id="7"/></w:trPr>'
        "<w:tc><w:p><w:r><w:t>Deleted row</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"
        '<w:p><w:moveFromRangeStart w:id="8"/>'
        '<w:r><w:t>Unwrapped move</w:t></w:r><w:moveFromRangeEnd w:id="8"/></w:p>'
        "<w:p><w:r><w:t>Before missing branch</w:t></w:r>"
        '<mc:AlternateContent xmlns:x="urn:test:unsupported">'
        '<mc:Choice Requires="x"><w:r><w:t>Not selected</w:t></w:r></mc:Choice>'
        "</mc:AlternateContent></w:p>"
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Stable cell</w:t></w:r></w:p>"
        '<w:p><w:del w:id="9"><w:r><w:delText> old</w:delText></w:r></w:del>'
        '<w:ins w:id="10"><w:r><w:t>new</w:t></w:r></w:ins></w:p>'
        "</w:tc></w:tr></w:tbl>"
    )

    paragraphs = [item["content"] for item in _items(result, "text_block")]
    for paragraph, reason in zip(
        paragraphs[:5],
        (
            "paragraph_boundary_revision",
            "paragraph_boundary_revision",
            "table_structure_revision",
            "move_range_revision",
            "alternate_content_gap",
        ),
        strict=True,
    ):
        assert paragraph["text"] == ""
        assert paragraph["source_text"]
        assert paragraph["text_projection"] == "unavailable"
        assert paragraph["text_projection_reason"] == reason
    assert paragraphs[-1]["text"] == "new"
    assert paragraphs[-1]["source_text"] == " oldnew"

    deleted_table, stable_table = (item["content"] for item in _items(result, "table"))
    deleted = deleted_table["rows"][0][0]
    assert deleted["text_projection_reason"] == "table_structure_revision"
    assert deleted["text"] == "" and deleted["source_text"] == "Deleted row"
    stable = stable_table["rows"][0][0]
    assert stable["text_projection"] == "accepted_revisions"
    assert stable["text"] == "Stable cell\nnew"
    assert stable["source_text"] == "Stable cell\n oldnew"
