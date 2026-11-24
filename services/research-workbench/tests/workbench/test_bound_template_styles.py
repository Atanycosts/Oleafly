"""Bound-template style reads through the real local HTTP/storage boundary."""

import base64
from io import BytesIO
from zipfile import ZipFile

from research_file_workbench.common.hashing import sha256_bytes
from tests.journals.test_analysis import component_bytes, docx_bytes
from tests.workbench.test_server import _request
from tests.workbench.test_template_service import adopt_payload, snapshot, upload

WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
SCRIPTS = {"latin": True, "east_asian": True, "complex": True, "other": True}


def post(server, path, payload):
    return _request(server, "POST", path, payload, server.session_token)


def style_object_id(path, part="/word/document.xml"):
    return f"{part}#{'.'.join(str(index) for index in path)}"


def paragraph(
    path,
    style_id,
    text,
    role,
    *,
    outline=None,
    alignment="left",
):
    role_basis = (
        [{"source": "outline_level", "value": str(outline), "certainty": "explicit"}]
        if outline is not None
        else [{"source": "style_name", "value": "Body Text", "certainty": "inferred"}]
    )
    return {
        "object_id": style_object_id(path),
        "part": "/word/document.xml",
        "path": path,
        "kind": "paragraph",
        "role": role,
        "role_basis": role_basis,
        "text": text,
        "style_id": style_id,
        "properties": {
            "paragraph": {"alignment": alignment, "outlineLevel": outline},
            "paragraph_mark": {},
            "script_usage": SCRIPTS,
        },
        "declared": {},
        "evidence": {"top_level_body": True},
    }


def run(
    path,
    paragraph_path,
    paragraph_style_id,
    role,
    size,
    *,
    text="Example",
    bold=None,
    italic=None,
    style_id=None,
):
    properties = {"fontFamily": "Fixture Serif", "fontSizePt": size}
    if bold is not None:
        properties["bold"] = bold
    if italic is not None:
        properties["italic"] = italic
    result = {
        "object_id": style_object_id(path),
        "part": "/word/document.xml",
        "path": path,
        "kind": "run",
        "role": role,
        "role_basis": [],
        "text": text,
        "properties": {"run": properties, "run_properties": properties, "script_usage": SCRIPTS},
        "declared": {},
        "evidence": {
            "paragraph_object_id": style_object_id(paragraph_path),
            "paragraph_style_id": paragraph_style_id,
        },
    }
    if style_id is not None:
        result["style_id"] = style_id
        result["evidence"]["character_style_chain"] = [
            {"style_id": style_id, "name": style_id, "based_on": None, "type": "character"}
        ]
    return result


def style_definition(
    index,
    style_id,
    name,
    style_type,
    *,
    role="unknown",
    based_on=None,
    paragraph_properties=None,
    run_properties=None,
    declared=None,
    role_basis=None,
    effective_status=None,
):
    path = [0, index]
    result = {
        "object_id": style_object_id(path, "/word/styles.xml"),
        "part": "/word/styles.xml",
        "path": path,
        "style_id": style_id,
        "name": name,
        "type": style_type,
        "based_on": based_on,
        "role": role,
        "role_basis": role_basis or [],
        "properties": {
            "paragraph": paragraph_properties or {},
            "run": run_properties or {},
            "script_usage": SCRIPTS,
        },
        "declared": declared or {},
    }
    if effective_status is not None:
        result["effective_status"] = effective_status
    return result


def fixture(*, newer=False):
    styles = [
        (
            '<w:style w:type="paragraph" w:styleId="BaseBody">'
            '<w:name w:val="Body Text"/><w:rPr><w:sz w:val="20"/>'
            '<w:rFonts w:ascii="Fixture Serif"/></w:rPr></w:style>'
        ),
        (
            '<w:style w:type="paragraph" w:styleId="HeadingOne">'
            '<w:name w:val="Heading 1"/><w:basedOn w:val="BaseBody"/>'
            '<w:pPr><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr>'
            '<w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>'
        ),
        (
            '<w:style w:type="paragraph" w:styleId="HeadingOneAlt">'
            '<w:name w:val="Heading 1 Alt"/><w:basedOn w:val="BaseBody"/>'
            '<w:pPr><w:outlineLvl w:val="0"/></w:pPr>'
            '<w:rPr><w:b w:val="0"/><w:sz w:val="28"/></w:rPr></w:style>'
        ),
        (
            '<w:style w:type="character" w:styleId="Emphasis">'
            '<w:name w:val="Emphasis"/><w:rPr><w:i/></w:rPr></w:style>'
        ),
        (
            '<w:style w:type="table" w:styleId="Grid">'
            '<w:name w:val="Table Grid"/><w:tblPr><w:tblBorders/></w:tblPr></w:style>'
        ),
    ]
    if newer:
        styles.append(
            '<w:style w:type="paragraph" w:styleId="NewerHeading">'
            '<w:name w:val="Newer Heading"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr>'
            '<w:rPr><w:sz w:val="40"/></w:rPr></w:style>'
        )
    body = (
        '<w:p><w:pPr><w:pStyle w:val="HeadingOne"/>'
        '<w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr>'
        "<w:r><w:t>Heading one</w:t></w:r></w:p>"
        '<w:p><w:pPr><w:pStyle w:val="HeadingOne"/>'
        '<w:jc w:val="left"/><w:outlineLvl w:val="0"/></w:pPr>'
        '<w:r><w:rPr><w:sz w:val="30"/></w:rPr><w:t>Heading direct size</w:t></w:r></w:p>'
        '<w:p><w:pPr><w:pStyle w:val="HeadingOneAlt"/>'
        '<w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Heading alt</w:t></w:r></w:p>'
        '<w:p><w:pPr><w:pStyle w:val="BaseBody"/></w:pPr>'
        "<w:r><w:t>Body text</w:t></w:r>"
        '<w:r><w:rPr><w:rStyle w:val="Emphasis"/><w:i/></w:rPr>'
        "<w:t> emphasized</w:t></w:r></w:p>"
        '<w:p><w:pPr><w:pStyle w:val="BaseBody"/></w:pPr>'
        "<w:r><w:t>Second body</w:t></w:r></w:p>"
        '<w:p><w:pPr><w:pStyle w:val="BaseBody"/>'
        '<w:jc w:val="right"/><w:outlineLvl w:val="1"/></w:pPr>'
        '<w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t>Direct heading two</w:t></w:r></w:p>'
        "<w:p><w:r><w:t>Fig. 1: Direct caption</w:t></w:r></w:p>"
    )
    content = docx_bytes(body)
    stream = BytesIO(content)
    with ZipFile(stream, "a") as archive:
        archive.writestr(
            "word/styles.xml",
            f'<w:styles xmlns:w="{WORD}">{"".join(styles)}</w:styles>',
        )
    content = stream.getvalue()
    facts = snapshot(content)
    facts["style_definitions"] = [
        style_definition(
            0,
            "BaseBody",
            "Body Text",
            "paragraph",
            role="body",
            run_properties={"fontFamily": "Fixture Serif", "fontSizePt": 10},
            declared={"run": {"fontFamily": "Fixture Serif", "fontSizePt": 10}},
            role_basis=[{"source": "style_name", "value": "Body Text", "certainty": "inferred"}],
            effective_status="paragraph_and_run",
        ),
        style_definition(
            1,
            "HeadingOne",
            "Heading 1",
            "paragraph",
            role="heading",
            based_on="BaseBody",
            paragraph_properties={"alignment": "center", "outlineLevel": 0},
            run_properties={
                "fontFamily": "Fixture Serif",
                "fontSizePt": 12,
                "bold": True,
            },
            declared={
                "paragraph": {"alignment": "center", "outlineLevel": 0},
                "run": {"fontSizePt": 12, "bold": True},
            },
            role_basis=[
                {"source": "style_name", "value": "Heading 1", "certainty": "inferred"},
                {"source": "outline_level", "value": "0", "certainty": "explicit"},
            ],
            effective_status="paragraph_and_run",
        ),
        style_definition(
            2,
            "HeadingOneAlt",
            "Heading 1 Alt",
            "paragraph",
            role="heading",
            based_on="BaseBody",
            paragraph_properties={"outlineLevel": 0},
            run_properties={
                "fontFamily": "Fixture Serif",
                "fontSizePt": 14,
                "bold": False,
            },
            declared={
                "paragraph": {"outlineLevel": 0},
                "run": {"fontSizePt": 14, "bold": False},
            },
            role_basis=[
                {"source": "style_name", "value": "Heading 1 Alt", "certainty": "inferred"},
                {"source": "outline_level", "value": "0", "certainty": "explicit"},
            ],
            effective_status="paragraph_and_run",
        ),
        style_definition(
            3,
            "Emphasis",
            "Emphasis",
            "character",
            run_properties={"italic": True},
            declared={"run": {"italic": True}},
            effective_status="run",
        ),
        style_definition(
            4,
            "Grid",
            "Table Grid",
            "table",
            declared={"table": {"borders": {}}},
            effective_status="declaration_only",
        ),
    ]
    if newer:
        facts["style_definitions"].append(
            style_definition(
                5,
                "NewerHeading",
                "Newer Heading",
                "paragraph",
                role="heading",
                paragraph_properties={"outlineLevel": 1},
                run_properties={"fontSizePt": 20},
                role_basis=[{"source": "outline_level", "value": "1", "certainty": "explicit"}],
                effective_status="paragraph_and_run",
            )
        )
    facts["objects"] = [
        paragraph([0, 0], "HeadingOne", "Heading one", "heading", outline=0, alignment="center"),
        run(
            [0, 0, 0],
            [0, 0],
            "HeadingOne",
            "heading",
            12,
            text="Heading one",
            bold=True,
        ),
        paragraph(
            [0, 1],
            "HeadingOne",
            "Heading direct size",
            "heading",
            outline=0,
            alignment="left",
        ),
        run(
            [0, 1, 0],
            [0, 1],
            "HeadingOne",
            "heading",
            15,
            text="Heading direct size",
            bold=True,
        ),
        paragraph(
            [0, 2],
            "HeadingOneAlt",
            "Heading alt",
            "heading",
            outline=0,
            alignment="left",
        ),
        run(
            [0, 2, 0],
            [0, 2],
            "HeadingOneAlt",
            "heading",
            14,
            text="Heading alt",
            bold=False,
        ),
        paragraph([0, 3], "BaseBody", "Body text emphasized", "body"),
        run([0, 3, 0], [0, 3], "BaseBody", "body", 10, text="Body text"),
        run(
            [0, 3, 1],
            [0, 3],
            "BaseBody",
            "body",
            10,
            text=" emphasized",
            italic=True,
            style_id="Emphasis",
        ),
        paragraph([0, 4], "BaseBody", "Second body", "body"),
        run([0, 4, 0], [0, 4], "BaseBody", "body", 10, text="Second body"),
        paragraph(
            [0, 5], "BaseBody", "Direct heading two", "heading", outline=1, alignment="right"
        ),
        run([0, 5, 0], [0, 5], "BaseBody", "heading", 11, text="Direct heading two"),
        paragraph([0, 6], None, "Fig. 1: Direct caption", "caption"),
        run([0, 6, 0], [0, 6], None, "caption", 10, text="Fig. 1: Direct caption"),
    ]
    del facts["objects"][-2]["style_id"]
    facts["objects"][-2]["role_basis"] = [
        {"source": "content", "value": "Fig. 1: Direct caption", "certainty": "inferred"}
    ]
    return content, facts


def setup_bound_project(server):
    content, facts = fixture()
    status, world = post(
        server, "/api/template-world", {**adopt_payload(content), "snapshot": facts}
    )
    assert status == 200, world
    status, project = post(
        server, "/api/projects", {"name": "Draft", **upload(content, "draft.docx")}
    )
    assert status == 200, project
    status, binding = post(
        server,
        "/api/bind",
        {
            "project_id": project["project_id"],
            "world_version_id": world["version_id"],
            "expected_binding_id": None,
        },
    )
    assert status == 200, binding
    return content, world, project, binding


def styles_query(server, project_id, **fields):
    return post(
        server,
        "/api/docx-query",
        {"target": {"project_id": project_id}, "operation": "template_styles", **fields},
    )


def test_template_styles_read_the_bound_world_not_a_newer_template(running_server):
    content, world, project, binding = setup_bound_project(running_server)
    newer_content, newer_facts = fixture(newer=True)
    status, newer = post(
        running_server,
        "/api/template-world",
        {**adopt_payload(newer_content), "snapshot": newer_facts},
    )
    assert status == 200, newer
    assert newer["version_id"] != world["version_id"]

    status, result = styles_query(running_server, project["project_id"])
    assert status == 200, result
    assert result["status"] == "available"
    assert result["binding"] == {
        "binding_id": binding["binding_id"],
        "world_version_id": world["version_id"],
        "baseline_id": project["baseline_id"],
        "previous_binding_id": None,
    }
    assert result["source_sha256"] == sha256_bytes(content)
    assert result["style_total"] == 5
    assert result["has_more"] and result["next_offset"] == 10
    assert [style["style_id"] for style in result["styles"]] == [
        "BaseBody",
        "HeadingOne",
        "HeadingOneAlt",
        "Emphasis",
        "Grid",
    ]
    assert "NewerHeading" not in {style["style_id"] for style in result["styles"]}
    assert running_server.service.store.get_binding(project["project_id"]) == binding


def test_template_styles_preserve_selectors_inheritance_variants_and_examples(running_server):
    _, _, project, binding = setup_bound_project(running_server)
    status, headings = styles_query(
        running_server,
        project["project_id"],
        role="heading",
        heading_level=1,
    )
    assert status == 200, headings
    assert headings["style_total"] == 2
    assert all(example["heading_level"] == 1 for example in headings["examples"])
    assert [style["style_id"] for style in headings["styles"]] == [
        "HeadingOne",
        "HeadingOneAlt",
    ]
    assert all(style["heading_level"] == 1 for style in headings["styles"])
    assert all(style["based_on"] == "BaseBody" for style in headings["styles"])
    assert [style["computed"]["run"]["fontSizePt"] for style in headings["styles"]] == [12, 14]
    assert all(
        style["computed"]["run"]["fontFamily"] == "Fixture Serif" for style in headings["styles"]
    )

    status, one = styles_query(running_server, project["project_id"], style_id="HeadingOne")
    assert status == 200, one
    assert one["style_total"] == 1
    style = one["styles"][0]
    assert style["declared"]["run"] == {"fontSizePt": 12, "bold": True}
    assert style["computed"]["run"]["fontFamily"] == "Fixture Serif"
    assert [
        item["properties"]["paragraph"]["alignment"]
        for item in one["examples"]
        if item["kind"] == "paragraph"
    ] == [
        "center",
        "left",
    ]
    assert [
        item["properties"]["run"]["fontSizePt"] for item in one["examples"] if item["kind"] == "run"
    ] == [12, 15]

    status, character = styles_query(running_server, project["project_id"], style_id="Emphasis")
    assert status == 200, character
    emphasis = character["styles"][0]
    assert emphasis["effective_status"] == "run"
    (sample,) = character["examples"]
    assert sample["kind"] == "run" and sample["style_id"] == "Emphasis"

    status, first = styles_query(
        running_server,
        project["project_id"],
        role="heading",
        heading_level=1,
        limit=1,
    )
    assert status == 200 and first["has_more"] and first["next_offset"] == 1
    status, second = styles_query(
        running_server,
        project["project_id"],
        role="heading",
        heading_level=1,
        offset=1,
        limit=1,
        expected_binding_id=binding["binding_id"],
    )
    assert status == 200 and second["styles"][0]["style_id"] == "HeadingOneAlt"
    assert second["has_more"] and second["next_offset"] == 2
    status, third = styles_query(
        running_server,
        project["project_id"],
        role="heading",
        heading_level=1,
        offset=2,
        limit=1,
        expected_binding_id=binding["binding_id"],
    )
    assert status == 200 and not third["styles"] and len(third["examples"]) == 1

    for invalid in (
        {"offset": 1},
        {"limit": 51},
        {"heading_level": 10},
        {"heading_level": True},
    ):
        status, refused = styles_query(running_server, project["project_id"], **invalid)
        assert status == 400, refused


def test_template_styles_find_direct_formatting_and_group_identical_examples(running_server):
    _, _, project, _ = setup_bound_project(running_server)
    status, heading = styles_query(running_server, project["project_id"], heading_level=2)
    assert status == 200, heading
    assert heading["styles"] == []
    paragraph_sample, run_sample = heading["examples"]
    assert paragraph_sample["style_id"] == "BaseBody"
    assert paragraph_sample["properties"]["paragraph"]["alignment"] == "right"
    assert run_sample["heading_level"] == 2 and run_sample["properties"]["run"]["fontSizePt"] == 11
    assert run_sample["evidence"]["paragraph_object_id"] == paragraph_sample["object_id"]

    status, caption = styles_query(running_server, project["project_id"], role="caption")
    assert status == 200 and caption["styles"] == []
    assert len(caption["examples"]) == 2
    assert caption["examples"][0]["style_id"] is None

    status, body = styles_query(running_server, project["project_id"], role="body")
    assert status == 200 and body["styles"][0]["style_id"] == "BaseBody"
    assert [(item["kind"], item["count"]) for item in body["examples"]] == [
        ("paragraph", 2),
        ("run", 2),
        ("run", 1),
    ]


def test_template_styles_report_unbound_and_non_template_bindings(running_server):
    content, _ = fixture()
    status, project = post(
        running_server,
        "/api/projects",
        {"name": "Unbound draft", **upload(content, "draft.docx")},
    )
    assert status == 200, project
    status, unbound = styles_query(running_server, project["project_id"])
    assert status == 200, unbound
    assert unbound == {
        "schema_version": 1,
        "operation": "template_styles",
        "project_id": project["project_id"],
        "status": "unbound",
        "binding": None,
        "source_sha256": None,
        "styles": [],
        "examples": [],
        "style_total": 0,
        "example_variant_total": 0,
        "total": 0,
        "has_more": False,
        "next_offset": None,
    }

    component = component_bytes({"page_width_twips": 20000}, journal_id="guide-test")
    status, world = post(
        running_server,
        "/api/worlds",
        {
            "journal_id": "guide-test",
            "journal_name": "Guide Test",
            "article_type": "research_article",
            "stage": "initial_submission",
            "language": "en",
            "sources": [
                {
                    "name": "component.json",
                    "kind": "rule_component_json",
                    "content_base64": base64.b64encode(component).decode(),
                }
            ],
        },
    )
    assert status == 200, world
    status, binding = post(
        running_server,
        "/api/bind",
        {
            "project_id": project["project_id"],
            "world_version_id": world["version_id"],
            "expected_binding_id": None,
        },
    )
    assert status == 200, binding
    status, unavailable = styles_query(running_server, project["project_id"])
    assert status == 200, unavailable
    assert unavailable["status"] == "template_unavailable"
    assert unavailable["binding"]["world_version_id"] == world["version_id"]
    assert unavailable["source_sha256"] is None
    assert unavailable["styles"] == [] and unavailable["total"] == 0


def test_template_styles_reject_a_changed_binding_pin(running_server):
    _, _, project, binding = setup_bound_project(running_server)
    status, first = styles_query(running_server, project["project_id"], limit=1)
    assert status == 200 and first["next_offset"] == 1

    newer_content, newer_facts = fixture(newer=True)
    status, newer = post(
        running_server,
        "/api/template-world",
        {**adopt_payload(newer_content), "snapshot": newer_facts},
    )
    assert status == 200, newer
    status, rebound = post(
        running_server,
        "/api/bind",
        {
            "project_id": project["project_id"],
            "world_version_id": newer["version_id"],
            "expected_binding_id": binding["binding_id"],
        },
    )
    assert status == 200, rebound

    status, refused = styles_query(
        running_server,
        project["project_id"],
        offset=1,
        limit=1,
        expected_binding_id=binding["binding_id"],
    )
    assert status == 409, refused
    status, current = styles_query(
        running_server,
        project["project_id"],
        expected_binding_id=rebound["binding_id"],
    )
    assert status == 200 and current["binding"]["world_version_id"] == newer["version_id"]
    assert current["binding"]["previous_binding_id"] == binding["binding_id"]
    assert "NewerHeading" in {style["style_id"] for style in current["styles"]}
