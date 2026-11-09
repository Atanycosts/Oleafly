from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path
from zipfile import ZipFile

import pytest
from docx import Document
from lxml import etree

PROJECT_ROOT = Path(__file__).resolve().parents[2]
TOOLS_ROOT = PROJECT_ROOT / "tools" / "fixture_building"
FIXTURE_ROOT = PROJECT_ROOT / "tests" / "fixtures" / "docx"
CATALOG_PATH = PROJECT_ROOT / "contracts" / "phase0" / "docx-fixture-catalog.json"

# The frozen Phase 0 source catalog declares the author workspace as a Windows absolute path,
# so the builder refuses to run where that path cannot be absolute.
requires_windows_author_workspace = pytest.mark.skipif(
    os.name != "nt",
    reason="frozen source catalog declares the Windows author workspace root",
)


def _load_builder_module():
    sys.path.insert(0, str(TOOLS_ROOT))
    specification = importlib.util.spec_from_file_location(
        "build_docx_fixtures", TOOLS_ROOT / "build_docx_fixtures.py"
    )
    if specification is None or specification.loader is None:
        raise RuntimeError("Cannot load the DOCX fixture builder")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _catalog() -> dict[str, object]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def rebuilt_project(tmp_path_factory: pytest.TempPathFactory) -> Path:
    project_root = tmp_path_factory.mktemp("fixture-project")
    builder = _load_builder_module()
    builder.build_fixtures(project_root)
    return project_root


def test_catalog_registers_seven_docx_and_three_non_docx_scenarios() -> None:
    catalog = _catalog()

    assert len(catalog["fixtures"]) == 7
    assert len(catalog["non_docx_scenarios"]) == 3
    assert {item["sample_id"] for item in catalog["fixtures"]} == {
        "s1-regions-fields",
        "s1-sections-layout",
        "s1-figures-tables",
        "s1-embedded-objects",
        "s1-broken-relationships",
        "s1-missing-font",
        "s1-pagination-ambiguity",
    }


def test_catalog_hashes_match_generated_files() -> None:
    catalog = _catalog()

    for item in catalog["fixtures"]:
        fixture_path = FIXTURE_ROOT / item["relative_path"]
        assert fixture_path.is_file()
        assert _sha256(fixture_path) == item["sha256"]


@requires_windows_author_workspace
def test_rebuild_is_byte_stable(rebuilt_project: Path) -> None:
    catalog = _catalog()

    for item in catalog["fixtures"]:
        rebuilt_path = rebuilt_project / "tests" / "fixtures" / "docx" / item["relative_path"]
        assert _sha256(rebuilt_path) == item["sha256"]


def test_repository_annotations_bind_to_hash_and_are_independently_reviewed() -> None:
    catalog = _catalog()

    for item in catalog["fixtures"]:
        annotation_path = PROJECT_ROOT / item["annotation_relative_path"]
        annotation = json.loads(annotation_path.read_text(encoding="utf-8"))
        assert annotation["artifact_sha256"] == item["sha256"]
        assert annotation["review_status"] == "reviewed"
        assert annotation["annotator"] == "independent-fixture-audit"
        assert annotation["review_method"]
        assert annotation["objects"]


@requires_windows_author_workspace
def test_rebuilt_annotations_start_pending_independent_review(rebuilt_project: Path) -> None:
    catalog = _catalog()

    for item in catalog["fixtures"]:
        annotation_path = rebuilt_project / item["annotation_relative_path"]
        annotation = json.loads(annotation_path.read_text(encoding="utf-8"))
        assert annotation["artifact_sha256"] == item["sha256"]
        assert annotation["review_status"] == "pending_review"
        assert annotation["annotator"] == "pending-independent-review"


def test_complex_objects_are_not_faked_as_generated() -> None:
    embedded = next(
        item for item in _catalog()["fixtures"] if item["sample_id"] == "s1-embedded-objects"
    )
    cases = {item["case_id"]: item for item in embedded["cases"]}

    for case_id in ("embedded_chart", "ole", "group_drawing"):
        assert cases[case_id]["implementation_status"] == "unsupported"
        assert cases[case_id]["expected_support"] == "declared_unsupported"
    assert cases["unknown_extension"]["implementation_status"] == "generated"
    assert cases["unknown_namespace"]["implementation_status"] == "generated"


def test_normal_fixtures_open_and_fault_fixture_is_a_zip_package() -> None:
    catalog = _catalog()

    for item in catalog["fixtures"]:
        fixture_path = FIXTURE_ROOT / item["relative_path"]
        with ZipFile(fixture_path) as archive:
            assert "word/document.xml" in archive.namelist()
        if item["sample_id"] != "s1-broken-relationships":
            document = Document(fixture_path)
            assert document.paragraphs


def test_required_ooxml_structures_are_present() -> None:
    regions_path = FIXTURE_ROOT / "normal/s1-regions-fields/s1-regions-fields.docx"
    figures_path = FIXTURE_ROOT / "normal/s1-figures-tables/s1-figures-tables.docx"
    embedded_path = FIXTURE_ROOT / "normal/s1-embedded-objects/s1-embedded-objects.docx"
    broken_path = FIXTURE_ROOT / "faults/s1-broken-relationships/s1-broken-relationships.docx"

    with ZipFile(regions_path) as archive:
        document_xml = archive.read("word/document.xml")
        document_root = etree.fromstring(document_xml)
        math_namespace = "http://schemas.openxmlformats.org/officeDocument/2006/math"
        assert document_root.xpath("count(.//m:oMath)", namespaces={"m": math_namespace}) >= 2
        assert document_root.xpath("count(.//m:oMathPara)", namespaces={"m": math_namespace}) == 1
        field_types = document_root.xpath(
            ".//w:p[contains(string(.), 'RFW-FX-RF-NESTED-FIELD-001')]//w:fldChar/@w:fldCharType",
            namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"},
        )
        assert field_types == ["begin", "begin", "separate", "end", "separate", "end"]
        assert b"<w:footnoteReference" in document_xml
        assert b"<w:endnoteReference" in document_xml
        assert b"<w:ins" in document_xml and b"<w:del" in document_xml
        assert b"ADDIN ZOTERO_ITEM" in document_xml
        assert b"word/footnotes.xml" not in document_xml
        assert "word/footnotes.xml" in archive.namelist()
        assert "word/endnotes.xml" in archive.namelist()
    with ZipFile(figures_path) as archive:
        document_xml = archive.read("word/document.xml")
        assert b"<wp:inline" in document_xml
        assert b"<wp:anchor" in document_xml
        assert b"<w:tblHeader" in document_xml
        figures_root = etree.fromstring(document_xml)
        anchor = figures_root.xpath(
            ".//wp:anchor",
            namespaces={
                "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            },
        )[0]
        assert [etree.QName(child).localname for child in anchor][:6] == [
            "simplePos",
            "positionH",
            "positionV",
            "extent",
            "wrapSquare",
            "docPr",
        ]
        assert b" SEQ " not in document_xml
    with ZipFile(embedded_path) as archive:
        assert "customXml/item1.xml" in archive.namelist()
        assert b"rfw:unknownObject" in archive.read("word/document.xml")
        rels_root = etree.fromstring(archive.read("word/_rels/document.xml.rels"))
        custom_xml_relationships = [
            relationship
            for relationship in rels_root
            if relationship.get("Type", "").endswith("/customXml")
        ]
        assert len(custom_xml_relationships) == 1
        assert custom_xml_relationships[0].get("Target") == "../customXml/item1.xml"
    with ZipFile(broken_path) as archive:
        rels_xml = archive.read("word/_rels/document.xml.rels")
        document_xml = archive.read("word/document.xml")
        assert b"rIdRfwMissingRelationship" in document_xml
        assert b"rIdRfwMissingInternalTarget" in rels_xml
        assert b'r:id="rIdRfwMissingExternalDependency"' in document_xml
        assert "word/missing-fragment.html" not in archive.namelist()


def test_restored_portrait_sections_do_not_retain_landscape_orientation() -> None:
    sections_path = FIXTURE_ROOT / "normal/s1-sections-layout/s1-sections-layout.docx"
    with ZipFile(sections_path) as archive:
        root = etree.fromstring(archive.read("word/document.xml"))
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    section_properties = root.xpath(".//w:sectPr", namespaces=namespace)
    assert len(section_properties) == 5
    orientations = section_properties[2].xpath("./w:pgSz/@w:orient", namespaces=namespace)
    assert orientations == ["landscape"]
    assert section_properties[3].xpath("./w:pgSz/@w:orient", namespaces=namespace) == []
    assert section_properties[4].xpath("./w:pgSz/@w:orient", namespaces=namespace) == []
