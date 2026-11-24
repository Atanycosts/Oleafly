"""Contract tests for Strict OOXML working-copy normalization."""

from __future__ import annotations

from hashlib import sha256
from io import BytesIO
from xml.etree import ElementTree
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from research_file_workbench.docx.normalization import (
    DocxNormalizationError,
    normalize_docx,
)

STRICT_BASE = "http://purl.oclc.org/ooxml/"
SCHEMA_BASE = "http://schemas.openxmlformats.org/"
STRICT_WORD = STRICT_BASE + "wordprocessingml/main"
WORD = SCHEMA_BASE + "wordprocessingml/2006/main"
STRICT_MATH = STRICT_BASE + "officeDocument/math"
TRANSITIONAL_MATH = SCHEMA_BASE + "officeDocument/2006/math"
STRICT_DRAWING = STRICT_BASE + "drawingml/main"
TRANSITIONAL_DRAWING = SCHEMA_BASE + "drawingml/2006/main"
STRICT_WORD_DRAWING = STRICT_BASE + "drawingml/wordprocessingDrawing"
TRANSITIONAL_WORD_DRAWING = SCHEMA_BASE + "drawingml/2006/wordprocessingDrawing"
STRICT_RELATIONSHIP_NAMESPACE = STRICT_BASE + "officeDocument/relationships"
TRANSITIONAL_RELATIONSHIP_NAMESPACE = SCHEMA_BASE + "officeDocument/2006/relationships"
STRICT_RELATIONSHIP_TYPES = STRICT_RELATIONSHIP_NAMESPACE + "/"
TRANSITIONAL_RELATIONSHIP_TYPES = TRANSITIONAL_RELATIONSHIP_NAMESPACE + "/"
PACKAGE_RELATIONSHIPS = SCHEMA_BASE + "package/2006/relationships"
PACKAGE_CONTENT_TYPES = SCHEMA_BASE + "package/2006/content-types"
OFFICE_DOCUMENT_RELATIONSHIP = "officeDocument"
STRICT_OFFICE_DOCUMENT = STRICT_RELATIONSHIP_TYPES + OFFICE_DOCUMENT_RELATIONSHIP
TRANSITIONAL_OFFICE_DOCUMENT = TRANSITIONAL_RELATIONSHIP_TYPES + OFFICE_DOCUMENT_RELATIONSHIP
TRANSITIONAL_MAIN = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
)
MARKUP_COMPATIBILITY = SCHEMA_BASE + "markup-compatibility/2006"
WORD_2010 = "http://schemas.microsoft.com/office/word/2010/wordml"
WORD_2012 = "http://schemas.microsoft.com/office/word/2012/wordml"
DIGITAL_SIGNATURE_ORIGIN_RELATIONSHIP = (
    SCHEMA_BASE + "package/2006/relationships/digital-signature/origin"
)
DIGITAL_SIGNATURE_RELATIONSHIP = (
    SCHEMA_BASE + "package/2006/relationships/digital-signature/signature"
)
DIGITAL_SIGNATURE_ORIGIN_CONTENT_TYPE = (
    "application/vnd.openxmlformats-package.digital-signature-origin"
)
DIGITAL_SIGNATURE_CONTENT_TYPE = (
    "application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml"
)
PROVENANCE_FIELDS = {"engine", "version", "method", "converted_sha256"}


def _sha256(payload: bytes) -> str:
    return sha256(payload).hexdigest()


def _archive(parts: dict[str, str | bytes]) -> bytes:
    stream = BytesIO()
    with ZipFile(stream, "w", ZIP_DEFLATED) as archive:
        for name, payload in parts.items():
            archive.writestr(name, payload)
    return stream.getvalue()


def _content_types(
    main_part: str = "/word/document.xml",
    main_content_type: str = TRANSITIONAL_MAIN,
    extra: str = "",
) -> str:
    return (
        f'<Types xmlns="{PACKAGE_CONTENT_TYPES}">'
        '<Default Extension="rels" '
        'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        f'<Override PartName="{main_part}" ContentType="{main_content_type}"/>'
        f"{extra}"
        "</Types>"
    )


def _relationships(entries: str) -> str:
    return f'<Relationships xmlns="{PACKAGE_RELATIONSHIPS}">{entries}</Relationships>'


def _relationship(
    relationship_id: str,
    relationship_type: str,
    target: str,
    *,
    target_mode: str | None = None,
) -> str:
    mode = f' TargetMode="{target_mode}"' if target_mode else ""
    return (
        f'<Relationship Id="{relationship_id}" Type="{relationship_type}" Target="{target}"{mode}/>'
    )


def _docx_package(
    document_xml: str,
    *,
    document_content_type: str = TRANSITIONAL_MAIN,
    package_relationships: str | None = None,
    document_relationships: str = "",
    extra_parts: dict[str, str | bytes] | None = None,
    extra_content_types: str = "",
) -> bytes:
    if package_relationships is None:
        package_relationships = _relationship(
            "rId1", TRANSITIONAL_OFFICE_DOCUMENT, "word/document.xml"
        )
    parts: dict[str, str | bytes] = {
        "[Content_Types].xml": _content_types(
            main_content_type=document_content_type, extra=extra_content_types
        ),
        "_rels/.rels": _relationships(package_relationships),
        "word/document.xml": document_xml,
        "word/_rels/document.xml.rels": _relationships(document_relationships),
    }
    parts.update(extra_parts or {})
    return _archive(parts)


def _strict_docx(
    document_xml: str,
    *,
    document_relationships: str = "",
    extra_parts: dict[str, str | bytes] | None = None,
    extra_content_types: str = "",
) -> bytes:
    return _docx_package(
        document_xml,
        package_relationships=_relationship("rId1", STRICT_OFFICE_DOCUMENT, "word/document.xml"),
        document_relationships=document_relationships,
        extra_parts=extra_parts,
        extra_content_types=extra_content_types,
    )


def _parts(content: bytes) -> dict[str, bytes]:
    with ZipFile(BytesIO(content)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def _relationship_elements(content: bytes) -> dict[str, dict[str, str]]:
    root = ElementTree.fromstring(content)
    assert root.tag == f"{{{PACKAGE_RELATIONSHIPS}}}Relationships"
    return {element.get("Id"): dict(element.attrib) for element in root}


def _assert_converted(source: bytes, result) -> None:
    assert result.original_sha256 == _sha256(source)
    assert result.source_sha256 == _sha256(result.content)
    assert result.original_sha256 != result.source_sha256
    assert isinstance(result.provenance, dict)
    assert set(result.provenance) == PROVENANCE_FIELDS
    for field in ("engine", "version", "method"):
        value = result.provenance[field]
        assert isinstance(value, str) and value.strip()
    assert result.provenance["converted_sha256"] == result.source_sha256


def _element_namespaces(root: ElementTree.Element) -> set[str]:
    namespaces = set()
    for element in root.iter():
        if element.tag.startswith("{"):
            namespaces.add(element.tag[1:].partition("}")[0])
    return namespaces


def _attribute_namespaces(root: ElementTree.Element) -> set[str]:
    namespaces = set()
    for element in root.iter():
        for name in element.attrib:
            if name.startswith("{"):
                namespaces.add(name[1:].partition("}")[0])
    return namespaces


def _namespace_declarations(content: bytes) -> dict[str, set[str]]:
    declarations: dict[str, set[str]] = {}
    for _, (prefix, uri) in ElementTree.iterparse(BytesIO(content), events=("start-ns",)):
        declarations.setdefault(prefix, set()).add(uri)
    return declarations


def _normalization_error(content: bytes, *, require_word_package: bool = False) -> str:
    with pytest.raises(DocxNormalizationError) as caught:
        normalize_docx(content, require_word_package=require_word_package)
    return caught.value.code


def test_strict_package_with_common_word_mime_and_opc_relationships_normalizes():
    source = _strict_docx(
        (
            f'<w:document xmlns:w="{STRICT_WORD}" xmlns:r="{STRICT_RELATIONSHIP_NAMESPACE}">'
            "<w:body><w:p><w:r><w:t>Strict source</w:t></w:r></w:p></w:body>"
            "</w:document>"
        ),
        document_relationships=_relationship(
            "rIdStyles", STRICT_RELATIONSHIP_TYPES + "styles", "styles.xml"
        ),
        extra_parts={"word/styles.xml": f'<w:styles xmlns:w="{STRICT_WORD}"/>'},
    )

    result = normalize_docx(source)
    _assert_converted(source, result)
    parts = _parts(result.content)

    content_types = ElementTree.fromstring(parts["[Content_Types].xml"])
    assert content_types.tag == f"{{{PACKAGE_CONTENT_TYPES}}}Types"
    overrides = {
        element.get("PartName"): element.get("ContentType")
        for element in content_types
        if element.tag == f"{{{PACKAGE_CONTENT_TYPES}}}Override"
    }
    assert overrides["/word/document.xml"] == TRANSITIONAL_MAIN

    package_relationships = _relationship_elements(parts["_rels/.rels"])
    assert package_relationships["rId1"]["Type"] == TRANSITIONAL_OFFICE_DOCUMENT
    document_relationships = _relationship_elements(parts["word/_rels/document.xml.rels"])
    assert document_relationships["rIdStyles"]["Type"] == (
        TRANSITIONAL_RELATIONSHIP_TYPES + "styles"
    )
    assert STRICT_WORD.encode() not in parts["word/document.xml"]
    assert STRICT_WORD.encode() not in parts["word/styles.xml"]


def test_transitional_package_is_an_exact_passthrough():
    source = _docx_package(
        f'<w:document xmlns:w="{WORD}"><w:body>'
        "<w:p><w:r><w:t>Transitional source</w:t></w:r></w:p>"
        "</w:body></w:document>"
    )

    result = normalize_docx(source)

    assert result.content == source
    assert result.original_sha256 == _sha256(source)
    assert result.source_sha256 == _sha256(source)
    assert result.provenance is None


@pytest.mark.parametrize(
    ("strict_suffix", "transitional_type", "target", "part_name"),
    [
        ("styles", TRANSITIONAL_RELATIONSHIP_TYPES + "styles", "styles.xml", "word/styles.xml"),
        (
            "customProperties",
            TRANSITIONAL_RELATIONSHIP_TYPES + "custom-properties",
            "../docProps/custom.xml",
            "docProps/custom.xml",
        ),
        (
            "extendedProperties",
            TRANSITIONAL_RELATIONSHIP_TYPES + "extended-properties",
            "../docProps/app.xml",
            "docProps/app.xml",
        ),
    ],
)
def test_known_strict_relationship_types_map_to_transitional_types(
    strict_suffix: str, transitional_type: str, target: str, part_name: str
):
    source = _strict_docx(
        (f'<w:document xmlns:w="{STRICT_WORD}"><w:body><w:p/></w:body></w:document>'),
        document_relationships=_relationship(
            "rIdMapped", STRICT_RELATIONSHIP_TYPES + strict_suffix, target
        ),
        extra_parts={part_name: b"<preserved/>"},
    )

    result = normalize_docx(source)
    _assert_converted(source, result)
    relationships = _relationship_elements(_parts(result.content)["word/_rels/document.xml.rels"])

    assert relationships["rIdMapped"]["Type"] == transitional_type
    assert relationships["rIdMapped"]["Target"] == target


def test_relationship_math_and_drawing_namespaces_are_rewritten():
    source = _strict_docx(
        (
            f'<w:document xmlns:w="{STRICT_WORD}" xmlns:r="{STRICT_RELATIONSHIP_NAMESPACE}" '
            f'xmlns:m="{STRICT_MATH}" xmlns:a="{STRICT_DRAWING}" '
            f'xmlns:wp="{STRICT_WORD_DRAWING}"><w:body><w:p>'
            "<w:r><w:t>Namespaces</w:t></w:r>"
            "<w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:r>"
            "<w:r><w:drawing><wp:inline><a:graphic><a:graphicData>"
            '<a:blip r:embed="rIdImage"/>'
            "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
            '<w:hyperlink r:id="rIdLink"><w:r><w:t>link</w:t></w:r></w:hyperlink>'
            "</w:p></w:body></w:document>"
        ),
        document_relationships=(
            _relationship("rIdImage", STRICT_RELATIONSHIP_TYPES + "image", "media/image1.png")
            + _relationship(
                "rIdLink",
                STRICT_RELATIONSHIP_TYPES + "hyperlink",
                "https://example.com",
                target_mode="External",
            )
        ),
        extra_parts={"word/media/image1.png": b"\x89PNG\r\n\x1a\n"},
        extra_content_types='<Default Extension="png" ContentType="image/png"/>',
    )

    result = normalize_docx(source)
    _assert_converted(source, result)
    root = ElementTree.fromstring(_parts(result.content)["word/document.xml"])
    namespaces = _element_namespaces(root)

    assert {
        WORD,
        TRANSITIONAL_MATH,
        TRANSITIONAL_DRAWING,
        TRANSITIONAL_WORD_DRAWING,
    } <= namespaces
    assert not any(namespace.startswith(STRICT_BASE) for namespace in namespaces)
    assert not any(namespace.startswith(STRICT_BASE) for namespace in _attribute_namespaces(root))

    hyperlink = root.find(f".//{{{WORD}}}hyperlink")
    assert hyperlink is not None
    assert hyperlink.get(f"{{{TRANSITIONAL_RELATIONSHIP_NAMESPACE}}}id") == "rIdLink"
    blip = root.find(f".//{{{TRANSITIONAL_DRAWING}}}blip")
    assert blip is not None
    assert blip.get(f"{{{TRANSITIONAL_RELATIONSHIP_NAMESPACE}}}embed") == "rIdImage"
    assert root.find(f".//{{{TRANSITIONAL_MATH}}}oMath") is not None
    assert root.find(f".//{{{TRANSITIONAL_WORD_DRAWING}}}inline") is not None


def test_measure_and_percentage_values_are_canonicalized():
    source = _strict_docx(
        f'<w:document xmlns:w="{STRICT_WORD}" xmlns:a="{STRICT_DRAWING}" '
        f'xmlns:m="{STRICT_MATH}"><w:body>'
        '<w:p><w:pPr><w:ind w:start="595.30pt" w:end="44.65pt" '
        'w:hanging="-12.5pt"/><w:spacing w:before="0pt" w:after="9pc"/>'
        "</w:pPr><w:r><w:t>Measures</w:t></w:r></w:p>"
        '<w:tbl><w:tblPr><w:tblW w:w="50%" w:type="pct"/></w:tblPr>'
        '<w:tr><w:tc><w:tcPr><w:tcW w:w="37.5%" w:type="pct"/></w:tcPr>'
        '<w:p><w:r><m:oMath><m:interSp m:val="12.5pt"/>'
        "<m:r><m:t>x</m:t></m:r></m:oMath></w:r></w:p></w:tc></w:tr></w:tbl>"
        "<w:p><w:r><w:drawing><a:graphic><a:graphicData>"
        '<a:ext cx="2.5cm" cy="1in"/><a:alpha val="50%"/>'
        "</a:graphicData></a:graphic></w:drawing></w:r></w:p>"
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>'
        "</w:body></w:document>"
    )

    result = normalize_docx(source)
    _assert_converted(source, result)
    root = ElementTree.fromstring(_parts(result.content)["word/document.xml"])

    indentation = root.find(f".//{{{WORD}}}ind")
    assert indentation is not None
    assert indentation.get(f"{{{WORD}}}start") == "11906"
    assert indentation.get(f"{{{WORD}}}end") == "893"
    assert indentation.get(f"{{{WORD}}}hanging") == "-250"
    spacing = root.find(f".//{{{WORD}}}spacing")
    assert spacing is not None
    assert spacing.get(f"{{{WORD}}}before") == "0"
    assert spacing.get(f"{{{WORD}}}after") == "2160"
    table_width = root.find(f".//{{{WORD}}}tblW")
    assert table_width is not None
    assert table_width.get(f"{{{WORD}}}w") == "2500"
    cell_width = root.find(f".//{{{WORD}}}tcW")
    assert cell_width is not None
    assert cell_width.get(f"{{{WORD}}}w") == "1875"
    math_spacing = root.find(f".//{{{TRANSITIONAL_MATH}}}interSp")
    assert math_spacing is not None
    assert math_spacing.get(f"{{{TRANSITIONAL_MATH}}}val") == "250"
    drawing_extent = root.find(f".//{{{TRANSITIONAL_DRAWING}}}ext")
    assert drawing_extent is not None
    assert drawing_extent.get("cx") == "900000"
    assert drawing_extent.get("cy") == "914400"
    alpha = root.find(f".//{{{TRANSITIONAL_DRAWING}}}alpha")
    assert alpha is not None
    assert alpha.get("val") == "50000"
    page_size = root.find(f".//{{{WORD}}}pgSz")
    assert page_size is not None
    assert page_size.get(f"{{{WORD}}}w") == "11906"
    assert page_size.get(f"{{{WORD}}}h") == "16838"


@pytest.mark.parametrize(
    ("line", "rule", "expected"),
    [("6pt", "auto", "120"), ("11.40pt", "auto", "228"), ("9pt", "exact", "180")],
)
def test_strict_spacing_preserves_the_line_rule(line: str, rule: str, expected: str):
    source = _strict_docx(
        f'<w:document xmlns:w="{STRICT_WORD}"><w:body><w:p><w:pPr>'
        f'<w:spacing w:line="{line}" w:lineRule="{rule}"/>'
        "</w:pPr></w:p></w:body></w:document>"
    )

    document = ElementTree.fromstring(_parts(normalize_docx(source).content)["word/document.xml"])

    spacing = document.find(f".//{{{WORD}}}spacing")
    assert spacing is not None
    assert spacing.get(f"{{{WORD}}}line") == expected
    assert spacing.get(f"{{{WORD}}}lineRule") == rule


def test_all_strict_word_prefixes_are_rewritten():
    source = _strict_docx(
        f'<w:document xmlns:w="{STRICT_WORD}" xmlns:w2="{STRICT_WORD}">'
        "<w2:body><w:p><w2:pPr>"
        '<w:ind w:start="9pt" w2:end="1in"/>'
        "</w2:pPr><w:r><w2:t>Alias</w2:t></w:r></w:p></w2:body>"
        "</w:document>"
    )

    result = normalize_docx(source)
    _assert_converted(source, result)
    root = ElementTree.fromstring(_parts(result.content)["word/document.xml"])

    assert root.tag == f"{{{WORD}}}document"
    assert not any(namespace.startswith(STRICT_BASE) for namespace in _element_namespaces(root))
    assert not any(namespace.startswith(STRICT_BASE) for namespace in _attribute_namespaces(root))
    indentation = root.find(f".//{{{WORD}}}ind")
    assert indentation is not None
    assert indentation.get(f"{{{WORD}}}start") == "180"
    assert indentation.get(f"{{{WORD}}}end") == "1440"
    assert "Alias" in "".join(root.itertext())


def test_alternate_content_choice_and_extension_metadata_are_preserved():
    source = _strict_docx(
        f'<w:document xmlns:w="{STRICT_WORD}" xmlns:mc="{MARKUP_COMPATIBILITY}" '
        f'xmlns:w14="{WORD_2010}" xmlns:w15="{WORD_2012}"><w:body>'
        '<mc:AlternateContent><mc:Choice Requires="w14 w15">'
        '<w:p w14:paraId="12345678" w15:paraIdParent="87654321">'
        "<w:r><w:t>selected branch</w:t></w:r></w:p>"
        "</mc:Choice><mc:Fallback><w:p><w:r><w:t>fallback branch</w:t>"
        "</w:r></w:p></mc:Fallback></mc:AlternateContent>"
        "</w:body></w:document>"
    )

    result = normalize_docx(source)
    _assert_converted(source, result)
    document = _parts(result.content)["word/document.xml"]
    root = ElementTree.fromstring(document)

    choice = root.find(f".//{{{MARKUP_COMPATIBILITY}}}Choice")
    assert choice is not None
    assert choice.get("Requires") == "w14 w15"
    paragraph = choice.find(f"{{{WORD}}}p")
    assert paragraph is not None
    assert paragraph.get(f"{{{WORD_2010}}}paraId") == "12345678"
    assert paragraph.get(f"{{{WORD_2012}}}paraIdParent") == "87654321"
    assert "selected branch" in "".join(choice.itertext())
    declarations = _namespace_declarations(document)
    assert WORD_2010 in declarations["w14"]
    assert WORD_2012 in declarations["w15"]


@pytest.mark.parametrize("include_signature_relationship", [False, True])
def test_digital_signature_relationships_are_unsupported(
    include_signature_relationship: bool,
):
    origin_relationship = _relationship(
        "rIdSignatureOrigin",
        DIGITAL_SIGNATURE_ORIGIN_RELATIONSHIP,
        "_xmlsignatures/origin.sigs",
    )
    signature_relationship = _relationship(
        "rIdSignature", DIGITAL_SIGNATURE_RELATIONSHIP, "sig1.xml"
    )
    extra_parts: dict[str, str | bytes] = {
        "_xmlsignatures/origin.sigs": b"origin",
        "_xmlsignatures/sig1.xml": b"signature",
    }
    if include_signature_relationship:
        extra_parts["_xmlsignatures/_rels/origin.sigs.rels"] = _relationships(
            signature_relationship
        )
    source = _docx_package(
        (f'<w:document xmlns:w="{STRICT_WORD}"><w:body><w:p/></w:body></w:document>'),
        package_relationships=(
            _relationship("rId1", STRICT_OFFICE_DOCUMENT, "word/document.xml") + origin_relationship
        ),
        extra_parts=extra_parts,
    )

    assert _normalization_error(source) == "strict_docx_unsupported"


@pytest.mark.parametrize(
    ("part_name", "content_type"),
    [
        ("_xmlsignatures/origin.sigs", DIGITAL_SIGNATURE_ORIGIN_CONTENT_TYPE),
        ("_xmlsignatures/sig1.xml", DIGITAL_SIGNATURE_CONTENT_TYPE),
    ],
)
def test_digital_signature_content_types_are_unsupported(part_name: str, content_type: str):
    source = _strict_docx(
        (f'<w:document xmlns:w="{STRICT_WORD}"><w:body><w:p/></w:body></w:document>'),
        extra_parts={part_name: b"signature material"},
        extra_content_types=(f'<Override PartName="/{part_name}" ContentType="{content_type}"/>'),
    )

    assert _normalization_error(source) == "strict_docx_unsupported"


def test_invalid_zip_is_a_typed_invalid_docx():
    assert _normalization_error(b"not a ZIP package") == "invalid_docx"


def test_package_without_word_document_is_invalid():
    source = _archive(
        {
            "[Content_Types].xml": _content_types(),
            "_rels/.rels": _relationships(
                _relationship("rId1", TRANSITIONAL_OFFICE_DOCUMENT, "word/document.xml")
            ),
        }
    )

    assert _normalization_error(source) == "invalid_docx"


def test_malformed_content_types_is_invalid():
    source = _archive(
        {
            "[Content_Types].xml": "<Types",
            "_rels/.rels": _relationships(
                _relationship("rId1", TRANSITIONAL_OFFICE_DOCUMENT, "word/document.xml")
            ),
            "word/document.xml": (f'<w:document xmlns:w="{WORD}"><w:body/></w:document>'),
        }
    )

    assert _normalization_error(source) == "invalid_docx"


def test_main_root_must_match_the_declared_word_package():
    source = _docx_package(f'<w:notDocument xmlns:w="{WORD}"/>')

    assert _normalization_error(source) == "invalid_docx"


def test_strict_word_without_the_package_relationship_reports_what_is_missing():
    source = _docx_package(
        f'<w:document xmlns:w="{STRICT_WORD}"><w:body/></w:document>',
        package_relationships="",
    )

    with pytest.raises(DocxNormalizationError, match="Strict Word.*main document relationship"):
        normalize_docx(source, require_word_package=True)


def test_strict_word_with_a_different_main_part_reports_the_layout_limit():
    part = "content/main.xml"
    source = _archive(
        {
            "[Content_Types].xml": _content_types(main_part=f"/{part}"),
            "_rels/.rels": _relationships(_relationship("rId1", STRICT_OFFICE_DOCUMENT, part)),
            part: f'<w:document xmlns:w="{STRICT_WORD}"><w:body/></w:document>',
        }
    )

    with pytest.raises(DocxNormalizationError, match="outside the supported layout") as caught:
        normalize_docx(source, require_word_package=True)
    assert caught.value.code == "strict_docx_unsupported"


def test_require_word_package_rejects_a_valid_strict_spreadsheet():
    source = _archive(
        {
            "[Content_Types].xml": _content_types(
                main_part="/xl/workbook.xml",
                main_content_type="application/vnd.ms-excel.sheet.main+xml",
            ),
            "_rels/.rels": _relationships(
                _relationship("rId1", STRICT_OFFICE_DOCUMENT, "xl/workbook.xml")
            ),
            "xl/workbook.xml": (f'<x:workbook xmlns:x="{STRICT_BASE}spreadsheetml/main"/>'),
        }
    )

    assert _normalization_error(source, require_word_package=True) == "invalid_docx"


def test_original_custom_and_unknown_xml_parts_are_not_rewritten():
    custom_xml = (
        b'<?xml version="1.0" encoding="UTF-8"?>\n'
        b'<custom xmlns="urn:example:custom">\n  <item>keep exactly</item>\n</custom>\n'
    )
    unknown_xml = (
        b'<?xml version="1.0" encoding="UTF-8"?>\n'
        b'<unknown xmlns="urn:example:unknown"><value>keep</value></unknown>\n'
    )
    source = _strict_docx(
        (f'<w:document xmlns:w="{STRICT_WORD}"><w:body><w:p/></w:body></w:document>'),
        document_relationships=_relationship(
            "rIdCustom",
            STRICT_RELATIONSHIP_TYPES + "customXml",
            "../customXml/item1.xml",
        ),
        extra_parts={
            "customXml/item1.xml": custom_xml,
            "word/unknown-part.xml": unknown_xml,
        },
    )
    original = bytes(source)

    result = normalize_docx(source)
    _assert_converted(source, result)
    parts = _parts(result.content)

    assert source == original
    assert parts["customXml/item1.xml"] == custom_xml
    assert parts["word/unknown-part.xml"] == unknown_xml


@pytest.mark.parametrize(
    ("strict", "alignment"),
    [(True, "start"), (False, "left")],
)
def test_non_bidi_logical_start_alignment_remains_supported(strict: bool, alignment: str):
    namespace = STRICT_WORD if strict else WORD
    document = (
        f'<w:document xmlns:w="{namespace}"><w:body><w:p>'
        f'<w:pPr><w:jc w:val="{alignment}"/></w:pPr>'
        "<w:r><w:t>Direction</w:t></w:r></w:p></w:body></w:document>"
    )
    source = _strict_docx(document) if strict else _docx_package(document)

    result = normalize_docx(source)
    if strict:
        _assert_converted(source, result)
    else:
        assert result.content == source
    root = ElementTree.fromstring(_parts(result.content)["word/document.xml"])

    paragraph_properties = root.find(f".//{{{WORD}}}pPr")
    assert paragraph_properties is not None
    justification = paragraph_properties.find(f"{{{WORD}}}jc")
    assert justification is not None
    assert justification.get(f"{{{WORD}}}val") in {"start", "left"}
    assert not any(element.tag.rsplit("}", 1)[-1] == "bidi" for element in root.iter())
