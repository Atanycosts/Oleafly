"""Regression tests for bounded raw DOCX package queries."""

import base64
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.docx.package_query import PackageQueryError, query_package

WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_RELATIONSHIP = "http://schemas.openxmlformats.org/package/2006/relationships"
DOCUMENT_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
)


def package(
    *,
    document: str | None = None,
    relationships: str | None = None,
    extra: dict[str, bytes | str] | None = None,
) -> bytes:
    stream = BytesIO()
    with ZipFile(stream, "w", ZIP_DEFLATED) as archive:
        overrides = [
            f'<Override PartName="/word/document.xml" ContentType="{DOCUMENT_CONTENT_TYPE}"/>'
        ]
        if extra:
            for name, content in extra.items():
                if name.endswith(".xml"):
                    overrides.append(
                        f'<Override PartName="/{name}" ContentType="application/xml"/>'
                    )
                archive.writestr(name, content)
        archive.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" '
            'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            + "".join(overrides)
            + "</Types>",
        )
        archive.writestr(
            "word/document.xml",
            document
            or (
                f'<w:document xmlns:w="{WORD}" xmlns:r="{RELATIONSHIP}">'
                f"<w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body>"
                "</w:document>"
            ),
        )
        if relationships is not None:
            archive.writestr("word/_rels/document.xml.rels", relationships)
    return stream.getvalue()


def relationships(*items: tuple[str, str, str, str | None]) -> str:
    entries = []
    for identifier, relationship_type, target, target_mode in items:
        mode = "" if target_mode is None else f' TargetMode="{target_mode}"'
        entries.append(
            f'<Relationship Id="{identifier}" Type="{relationship_type}" Target="{target}"{mode}/>'
        )
    return f'<Relationships xmlns="{PACKAGE_RELATIONSHIP}">' + "".join(entries) + "</Relationships>"


def test_part_returns_exact_bytes_hash_length_and_content_type() -> None:
    payload = package()
    with ZipFile(BytesIO(payload)) as archive:
        expected = archive.read("word/document.xml")

    result = query_package(
        payload,
        {"operation": "part", "part": "word/document.xml"},
    )

    assert result["schema_version"] == 1
    assert result["source_sha256"] == sha256_bytes(payload)
    assert result["operation"] == "part"
    assert result["part"] == "/word/document.xml"
    assert base64.b64decode(result["content_base64"]) == expected
    assert result["sha256"] == sha256_bytes(expected)
    assert result["byte_length"] == len(expected)
    assert result["content_type"] == DOCUMENT_CONTENT_TYPE


def test_part_queries_remain_available_when_an_xml_part_is_malformed() -> None:
    payload = package(extra={"customXml/item1.xml": b"<broken>"})

    result = query_package(
        payload,
        {"operation": "part", "part": "/customXml/item1.xml"},
    )

    assert base64.b64decode(result["content_base64"]) == b"<broken>"
    with pytest.raises(PackageQueryError, match="Malformed XML part /customXml/item1.xml"):
        query_package(
            payload,
            {"operation": "nodes", "part": "/customXml/item1.xml"},
        )


def test_unknown_namespace_element_and_attribute_remain_queryable() -> None:
    payload = package(
        extra={
            "customXml/item1.xml": (
                '<vendor:record xmlns:vendor="urn:vendor" vendor:key="alpha">'
                "<vendor:field>value</vendor:field>"
                "</vendor:record>"
            )
        }
    )

    result = query_package(
        payload,
        {
            "operation": "nodes",
            "part": "/customXml/item1.xml",
            "namespace_uri": "urn:vendor",
            "local_name": "record",
            "attribute": {
                "namespace_uri": "urn:vendor",
                "local_name": "key",
                "value": "alpha",
            },
        },
    )

    assert result["total"] == 1
    node = result["nodes"][0]
    assert node["path"] == [0]
    assert node["namespace_uri"] == "urn:vendor"
    assert node["local_name"] == "record"
    assert node["attributes"] == [
        {"namespace_uri": "urn:vendor", "local_name": "key", "value": "alpha"}
    ]
    assert node["children"] == [
        {
            "kind": "element",
            "index": 0,
            "path": [0, 0],
            "namespace_uri": "urn:vendor",
            "local_name": "field",
        }
    ]


def test_nodes_use_canonical_paths_and_count_mixed_content_slots() -> None:
    document = (
        f'<w:document xmlns:w="{WORD}"><w:body>'
        "<w:p>before<w:r><w:t>A</w:t></w:r>between"
        "<w:r><w:t>B</w:t></w:r>after</w:p>"
        "<w:p>  <w:r><w:t>C</w:t></w:r>  </w:p>"
        "</w:body></w:document>"
    )
    payload = package(document=document)

    result = query_package(
        payload,
        {"operation": "nodes", "part": "/word/document.xml", "path": [0, 0, 0]},
    )

    assert result["total"] == 1
    paragraph = result["nodes"][0]
    assert paragraph["path"] == [0, 0, 0]
    assert paragraph["local_name"] == "p"
    assert [
        (child["kind"], child["index"], child["path"], child.get("value"))
        for child in paragraph["children"]
    ] == [
        ("text_value", 0, [0, 0, 0, 0], "before"),
        ("element", 1, [0, 0, 0, 1], None),
        ("text_value", 2, [0, 0, 0, 2], "between"),
        ("element", 3, [0, 0, 0, 3], None),
        ("text_value", 4, [0, 0, 0, 4], "after"),
    ]

    first_run = query_package(
        payload,
        {"operation": "nodes", "part": "/word/document.xml", "path": [0, 0, 0, 1]},
    )
    assert first_run["nodes"][0]["local_name"] == "r"

    text_slot = query_package(
        payload,
        {"operation": "nodes", "part": "/word/document.xml", "path": [0, 0, 0, 0]},
    )
    assert text_slot["total"] == 0

    second_paragraph = query_package(
        payload,
        {"operation": "nodes", "part": "/word/document.xml", "path": [0, 0, 1]},
    )
    assert [
        (child["kind"], child["index"]) for child in second_paragraph["nodes"][0]["children"]
    ] == [("element", 0)]


def test_nodes_honor_inherited_and_default_reset_xml_space() -> None:
    payload = package(
        extra={
            "customXml/item1.xml": (
                '<vendor:record xmlns:vendor="urn:vendor" xml:space="preserve">'
                " <vendor:field/> "
                '<vendor:reset xml:space="default"> <vendor:leaf/> </vendor:reset>'
                "</vendor:record>"
            )
        }
    )

    result = query_package(
        payload,
        {
            "operation": "nodes",
            "part": "/customXml/item1.xml",
            "namespace_uri": "urn:vendor",
            "local_name": "field",
        },
    )
    reset = query_package(
        payload,
        {
            "operation": "nodes",
            "part": "/customXml/item1.xml",
            "namespace_uri": "urn:vendor",
            "local_name": "reset",
        },
    )
    leaf = query_package(
        payload,
        {
            "operation": "nodes",
            "part": "/customXml/item1.xml",
            "namespace_uri": "urn:vendor",
            "local_name": "leaf",
        },
    )

    assert result["nodes"][0]["path"] == [0, 1]
    assert reset["nodes"][0]["path"] == [0, 3]
    assert [
        (child["kind"], child["index"], child.get("value"))
        for child in reset["nodes"][0]["children"]
    ] == [("element", 0, None)]
    assert leaf["nodes"][0]["path"] == [0, 3, 0]

    root = query_package(
        payload,
        {"operation": "nodes", "part": "/customXml/item1.xml", "path": [0]},
    )
    assert [
        (child["kind"], child["index"], child.get("value"))
        for child in root["nodes"][0]["children"]
    ] == [
        ("text_value", 0, " "),
        ("element", 1, None),
        ("text_value", 2, " "),
        ("element", 3, None),
    ]


def test_node_filters_and_pagination_are_deterministic() -> None:
    document = (
        f'<w:document xmlns:w="{WORD}"><w:body>'
        '<w:p w:val="keep"/><w:p w:val="drop"/><w:p w:val="keep"/>'
        "</w:body></w:document>"
    )
    payload = package(document=document)

    first = query_package(
        payload,
        {
            "operation": "nodes",
            "part": "/word/document.xml",
            "namespace_uri": WORD,
            "local_name": "p",
            "attribute": {"namespace_uri": WORD, "local_name": "val", "value": "keep"},
            "offset": 0,
            "limit": 1,
        },
    )
    second = query_package(
        payload,
        {
            "operation": "nodes",
            "part": "/word/document.xml",
            "namespace_uri": WORD,
            "local_name": "p",
            "attribute": {"namespace_uri": WORD, "local_name": "val", "value": "keep"},
            "offset": 1,
            "limit": 1,
        },
    )

    assert first["total"] == 2
    assert first["has_more"] is True
    assert first["next_offset"] == 1
    assert first["nodes"][0]["path"] == [0, 0, 0]
    assert second["total"] == 2
    assert second["has_more"] is False
    assert second["next_offset"] is None
    assert second["nodes"][0]["path"] == [0, 0, 2]


def test_relationships_resolve_internal_targets_and_keep_external_targets() -> None:
    payload = package(
        relationships=relationships(
            ("rId1", f"{RELATIONSHIP}/header", "header1.xml", None),
            (
                "rId2",
                f"{RELATIONSHIP}/hyperlink",
                "https://example.invalid/reference",
                "External",
            ),
            ("rId3", f"{RELATIONSHIP}/image", "media/missing.png", None),
        ),
        extra={
            "word/header1.xml": (
                f'<w:hdr xmlns:w="{WORD}"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>'
            )
        },
    )

    first = query_package(
        payload,
        {
            "operation": "relationships",
            "part": "/word/document.xml",
            "offset": 0,
            "limit": 2,
        },
    )
    second = query_package(
        payload,
        {
            "operation": "relationships",
            "part": "/word/document.xml",
            "offset": 2,
            "limit": 2,
        },
    )

    assert first["total"] == 3
    assert first["has_more"] is True
    assert first["next_offset"] == 2
    assert first["relationships"][0] == {
        "relationship_part": "/word/_rels/document.xml.rels",
        "source_part": "/word/document.xml",
        "relationship_id": "rId1",
        "relationship_type": f"{RELATIONSHIP}/header",
        "target": "header1.xml",
        "target_mode": None,
        "resolved_target": "/word/header1.xml",
        "explicit_external": False,
    }
    assert first["relationships"][1]["resolved_target"] is None
    assert first["relationships"][1]["explicit_external"] is True
    assert second["relationships"][0]["resolved_target"] is None
    assert second["has_more"] is False


def test_root_relationships_have_a_package_root_owner() -> None:
    root_relationships = relationships(
        (
            "rId1",
            f"{RELATIONSHIP}/officeDocument",
            "word/document.xml",
            None,
        )
    )
    payload = package(extra={"_rels/.rels": root_relationships})

    result = query_package(
        payload,
        {"operation": "relationships", "part": "/"},
    )

    assert result["relationships"][0]["source_part"] == "/"
    assert result["relationships"][0]["resolved_target"] == "/word/document.xml"


@pytest.mark.parametrize(
    "query,message",
    [
        ({"operation": "unknown"}, "Unsupported package query operation"),
        ({"operation": "part"}, "missing fields: part"),
        (
            {"operation": "part", "part": "/word/document.xml", "extra": True},
            "unknown fields: extra",
        ),
        (
            {"operation": "part", "part": "/word/missing.xml"},
            "Unknown DOCX part",
        ),
        (
            {"operation": "part", "part": "/word/../document.xml"},
            "Invalid DOCX part path",
        ),
        (
            {"operation": "part", "part": "word\\\\document.xml"},
            "Invalid DOCX part path",
        ),
        (
            {"operation": "nodes", "part": "/word/document.xml", "path": [0, True]},
            "path entries must be non-negative integers",
        ),
        (
            {"operation": "nodes", "part": "/word/document.xml", "path": [0, 99]},
            "Node path is outside",
        ),
        (
            {"operation": "nodes", "part": "/word/document.xml", "limit": 0},
            "limit must be at least 1",
        ),
        (
            {"operation": "nodes", "part": "/word/document.xml", "limit": 1001},
            "limit must not exceed 1000",
        ),
        (
            {
                "operation": "nodes",
                "part": "/word/document.xml",
                "attribute": {"value": "x"},
            },
            "missing fields: local_name",
        ),
    ],
)
def test_malformed_queries_fail_loudly(query, message: str) -> None:
    with pytest.raises(PackageQueryError, match=message):
        query_package(package(), query)


def test_nodes_refuse_a_binary_part_instead_of_inventing_xml() -> None:
    payload = package(extra={"word/media/image1.png": b"\x89PNG\r\n"})

    with pytest.raises(PackageQueryError, match="DOCX part is not XML"):
        query_package(
            payload,
            {"operation": "nodes", "part": "/word/media/image1.png"},
        )


def test_duplicate_zip_parts_are_refused() -> None:
    stream = BytesIO()
    with ZipFile(stream, "w") as archive:
        archive.writestr("word/document.xml", "<first/>")
        with pytest.warns(UserWarning, match="Duplicate name"):
            archive.writestr("word/document.xml", "<second/>")

    with pytest.raises(PackageQueryError, match="duplicate ZIP part names"):
        query_package(
            stream.getvalue(),
            {"operation": "part", "part": "/word/document.xml"},
        )
