from pathlib import Path
from zipfile import ZipFile

from lxml import etree

from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import load_json_object

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = PROJECT_ROOT / "contracts" / "phase0" / "native-docx-fixture-catalog.json"
FIXTURE_PATH = (
    PROJECT_ROOT
    / "tests"
    / "fixtures"
    / "docx"
    / "native"
    / "s1-native-complex-objects"
    / "s1-native-complex-objects.docx"
)


def test_native_complex_fixture_matches_fixed_snapshot_hash() -> None:
    catalog = load_json_object(CATALOG_PATH)
    fixtures = catalog["fixtures"]
    assert isinstance(fixtures, list)
    fixture = fixtures[0]
    assert isinstance(fixture, dict)
    assert sha256_file(FIXTURE_PATH) == fixture["sha256"]


def test_native_complex_fixture_contains_real_relationships_and_parts() -> None:
    with ZipFile(FIXTURE_PATH) as archive:
        names = set(archive.namelist())
        document = etree.fromstring(archive.read("word/document.xml"))
        relationships = etree.fromstring(archive.read("word/_rels/document.xml.rels"))
        chart_relationships = etree.fromstring(archive.read("word/charts/_rels/chart1.xml.rels"))

        assert "word/charts/chart1.xml" in names
        assert "word/embeddings/Workbook1.xlsx" in names
        assert "word/embeddings/oleObject1.bin" in names
        assert "word/media/image1.emf" in names

        namespace = {
            "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
            "o": "urn:schemas-microsoft-com:office:office",
            "wpg": "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
        }
        assert len(document.xpath(".//c:chart", namespaces=namespace)) == 1
        assert len(document.xpath(".//o:OLEObject", namespaces=namespace)) == 1
        assert len(document.xpath(".//wpg:wgp", namespaces=namespace)) == 1

        relationship_targets = {element.get("Target") for element in relationships}
        assert "charts/chart1.xml" in relationship_targets
        assert "embeddings/oleObject1.bin" in relationship_targets
        assert "media/image1.emf" in relationship_targets
        assert "../embeddings/Workbook1.xlsx" in {
            element.get("Target") for element in chart_relationships
        }


def test_native_embedded_payloads_have_expected_signatures() -> None:
    with ZipFile(FIXTURE_PATH) as archive:
        workbook = archive.read("word/embeddings/Workbook1.xlsx")
        ole_payload = archive.read("word/embeddings/oleObject1.bin")
        emf_preview = archive.read("word/media/image1.emf")

    assert workbook.startswith(b"PK")
    assert ole_payload.startswith(bytes.fromhex("D0CF11E0A1B11AE1"))
    assert b"RFW-FX-EO-OLE-PAYLOAD-001" in ole_payload
    assert len(emf_preview) > 100
