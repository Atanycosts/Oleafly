"""Validate frozen evidence against physical files and independently declared expectations."""

import posixpath
import re
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree
from zipfile import ZipFile

from research_file_workbench.common.filesystem import require_within
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.common.pdf import PdfInspectionError, read_pdf_page_count
from research_file_workbench.common.png import inspect_png
from research_file_workbench.phase0.contract_checks import (
    hash_value,
    keyed_records,
    object_array,
    string_array,
    string_value,
)
from research_file_workbench.phase0.models import ContractValueError


def validate_pdf_pages(
    record: JsonObject,
    *,
    project_root: Path | None = None,
    require_report_root: bool = False,
    pdf_key: str = "pdf_path",
    directory_key: str = "page_directory",
) -> None:
    """Check actual PDF page count and every registered PNG hash; fail on missing evidence."""
    report_root = project_root / "reports" if project_root is not None else None

    def evidence_path(value: str) -> Path:
        path = Path(value)
        if report_root is None:
            return path
        if path.exists():
            if require_report_root:
                require_within(path, report_root)
            return path
        normalized = posixpath.normpath(value.replace("\\", "/"))
        marker = "/reports/"
        if marker not in normalized:
            return path
        relative_path = PurePosixPath(normalized.split(marker, 1)[1])
        relocated = report_root / Path(*relative_path.parts)
        if require_report_root:
            require_within(relocated, report_root)
        return relocated

    pdf = evidence_path(string_value(record, pdf_key))
    if not pdf.is_file() or sha256_file(pdf) != hash_value(record, "pdf_sha256"):
        raise ContractValueError(f"PDF absent or hash mismatch: {pdf}")
    try:
        actual_count = read_pdf_page_count(pdf)
    except PdfInspectionError as exc:
        raise ContractValueError(str(exc)) from exc
    if type(record.get("page_count")) is not int or actual_count != record["page_count"]:
        raise ContractValueError(f"Actual PDF page count differs: {pdf}")
    directory = evidence_path(string_value(record, directory_key))
    pages = object_array(record, "pages")
    if any(type(item.get("page_number")) is not int for item in pages):
        raise ContractValueError("Page numbers must be integers")
    if len(pages) != actual_count or {item.get("page_number") for item in pages} != set(
        range(1, actual_count + 1)
    ):
        raise ContractValueError(f"Incomplete or duplicate page manifest: {pdf}")
    registered: set[Path] = set()
    for page in pages:
        path = evidence_path(string_value(page, "path"))
        require_within(path, directory)
        if path.resolve() in registered:
            raise ContractValueError("Duplicate page image path")
        registered.add(path.resolve())
        if not path.is_file() or sha256_file(path) != hash_value(page, "sha256"):
            raise ContractValueError(f"Page image absent or hash mismatch: {path}")
        inspect_png(path.read_bytes())
    if (
        not directory.is_dir()
        or {path.resolve() for path in directory.glob("page-*.png")} != registered
    ):
        raise ContractValueError("Actual page image set differs from manifest")


def validate_fixture_evidence(
    project_root: Path,
    source: Path,
    fixture: JsonObject,
    annotation: JsonObject,
    page_evidence: JsonObject,
    render: JsonObject,
    profile_id: str,
) -> None:
    """Check evidence identities and referential integrity without trusting reviewed flags."""
    sample_id = string_value(fixture, "sample_id")
    for record in (annotation, page_evidence, render):
        if record.get("sample_id") != sample_id:
            raise ContractValueError(f"Wrong sample identity: {sample_id}")
    if annotation.get("artifact_id") != fixture.get("artifact_id"):
        raise ContractValueError("Wrong annotation artifact identity")
    if page_evidence.get("render_profile_id") != profile_id:
        raise ContractValueError("Unknown or mismatched annotation render profile")
    recorded_source = string_value(render, "source_path")
    fixture_root = (project_root / "tests" / "fixtures" / "docx").resolve()
    relative_source = source.resolve().relative_to(fixture_root).as_posix()
    normalized_recorded_source = posixpath.normpath(recorded_source.replace("\\", "/"))
    same_current_path = Path(recorded_source).resolve() == source.resolve()
    marker = "/tests/fixtures/docx/"
    recorded_relative = (
        normalized_recorded_source.split(marker, 1)[1]
        if marker in normalized_recorded_source
        else None
    )
    same_historical_path = recorded_relative == relative_source
    if not same_current_path and not same_historical_path:
        raise ContractValueError("Render record points to another source")
    for key in ("registered_source_sha256", "actual_source_sha256"):
        if hash_value(render, key) != fixture["sha256"]:
            raise ContractValueError("Render source digest mismatch")
    if render.get("source_hash_matches") is not True or render.get("status") != "rendered":
        raise ContractValueError("Fixture render is not complete")
    validate_pdf_pages(render, project_root=project_root, require_report_root=True)
    objects = keyed_records(object_array(annotation, "objects"), "annotation_id")
    mappings = keyed_records(object_array(page_evidence, "mappings"), "annotation_id")
    with ZipFile(source) as archive:
        part_names = set(archive.namelist())
    for item in objects.values():
        for key in ("kind", "region", "locator", "expected_support", "review_status"):
            string_value(item, key)
        string_array(item, "expected_relations", nonempty=False)
        string_array(item, "limitations", nonempty=False)
        if item["review_status"] != "unsupported":
            # Existing annotations use human-readable locators; verify named package parts.
            # This does not claim to prove every prose assertion or replace independent review.
            parts = re.findall(
                r"\b(?:word|customXml)/[A-Za-z0-9_./-]+\.xml\b", string_value(item, "locator")
            )
            if not parts or any(part not in part_names for part in parts):
                raise ContractValueError(
                    "Annotation locator names absent or unspecified package parts"
                )
        if (
            item["review_status"] == "unsupported"
            and item["expected_support"] != "declared_unsupported"
        ):
            raise ContractValueError("Unsupported annotation cannot satisfy required coverage")
    for item in mappings.values():
        if item.get("object_annotation_id") not in objects:
            raise ContractValueError("Mapping refers to a missing structural annotation")
        string_value(item, "mapping_status")
        string_value(item, "evidence")
    if annotation.get("review_status") == "reviewed":
        for key in ("annotator", "reviewed_at", "review_method"):
            string_value(annotation, key)
    if page_evidence.get("review_status") == "reviewed":
        for key in ("reviewed_by", "reviewed_at", "review_method"):
            string_value(page_evidence, key)
    if sample_id == "s1-sections-layout":
        if "rfw-fx-sl-style-inheritance-001" not in objects:
            raise ContractValueError("Missing required style inheritance annotation")
        validate_style_expectation(source, objects["rfw-fx-sl-style-inheritance-001"])


def validate_style_expectation(source: Path, annotation: JsonObject) -> None:
    """Check explicit fixture values against its XML chain, not a future S1 reader."""
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    w = "{" + namespace["w"] + "}"
    with ZipFile(source) as archive:
        styles = ElementTree.fromstring(archive.read("word/styles.xml"))
    base = styles.find("w:style[@w:styleId='RFWFixtureBase']", namespace)
    child = styles.find("w:style[@w:styleId='RFWFixtureChild']", namespace)
    if base is None or child is None:
        raise ContractValueError("Missing independent style-chain fixture")
    checks = [
        (base, "w:rPr/w:rFonts", w + "ascii", "Arial"),
        (base, "w:rPr/w:sz", w + "val", "22"),
        (base, "w:pPr/w:spacing", w + "after", "160"),
        (child, "w:basedOn", w + "val", "RFWFixtureBase"),
        (base, "w:basedOn", w + "val", "Normal"),
    ]
    for parent, query, attribute, expected_value in checks:
        element = parent.find(query, namespace)
        if element is None or element.get(attribute) != expected_value:
            raise ContractValueError(f"Style fixture differs from reviewed expectation: {query}")
    if child.find("w:rPr/w:i", namespace) is None:
        raise ContractValueError("Expected explicit child italic property")
    expected = {
        "font_ascii": {"value": "Arial", "source_style": "RFWFixtureBase"},
        "font_size_pt": {"value": 11, "source_style": "RFWFixtureBase"},
        "italic": {"value": True, "source_style": "RFWFixtureChild"},
        "space_after_pt": {"value": 8, "source_style": "RFWFixtureBase"},
    }
    if annotation.get("expected_properties") != expected:
        raise ContractValueError("Missing or incorrect computed style expectations")
    if annotation.get("expected_style_chain") != ["RFWFixtureChild", "RFWFixtureBase", "Normal"]:
        raise ContractValueError("Missing or incorrect style source chain")
