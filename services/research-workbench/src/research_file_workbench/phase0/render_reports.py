"""Build new fixture evidence inventories without rendering or replacing frozen reports."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Literal, cast

from research_file_workbench.common.filesystem import (
    require_no_reparse_points,
    require_owned_output,
    require_within,
)
from research_file_workbench.common.hashing import sha256_bytes, sha256_file
from research_file_workbench.common.json_io import JsonObject, load_json_object, write_json_object
from research_file_workbench.common.pdf import read_pdf_page_count
from research_file_workbench.common.png import inspect_png
from research_file_workbench.phase0.contract_checks import hash_value, object_array, string_value
from research_file_workbench.phase0.contracts import load_source_catalog

MARKER_PATTERN = re.compile(r"RFW-FX-[A-Z0-9-]+")
_PAGE_NAME = re.compile(r"page-([0-9]+)\.png")
_SAMPLE_ID = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*")
_TEXT_TIMEOUT_SECONDS = 30


class FixtureReportError(ValueError):
    """Raised when existing fixture evidence cannot support a truthful report."""


def write_fixture_report(
    project_root: Path, output_path: Path, *, report_kind: Literal["page_index", "render_catalog"]
) -> JsonObject:
    """Validate captured fixture evidence and atomically publish one new report.

    Missing files yield an explicit partial inventory. Hash, image, page-number and inspection
    failures refuse publication. This operation does not render, attest WPS or review mappings.
    """
    require_no_reparse_points(project_root)
    project_root = project_root.resolve()
    contracts = project_root / "contracts" / "phase0"
    source_catalog = contracts / "source-catalog.json"
    _require_input(source_catalog, contracts)
    author_root, _ = load_source_catalog(source_catalog)
    _require_output(project_root, output_path, author_root)
    profile, dpi = _render_profile(contracts)
    fixtures = _fixture_entries(contracts)
    records = [
        _inspect_fixture(project_root, fixture, include_markers=report_kind == "page_index")
        for fixture in fixtures
    ]
    complete = all(record["status"] == "rendered" for record in records)
    if report_kind == "page_index":
        records = [_page_index_record(record) for record in records]
    report: JsonObject = {
        "report_version": "1.0.0",
        "status": "complete" if complete else "partial",
        "fixtures": records,
        "limitations": [
            "This inventory checks existing bytes and physical page counts; it does not execute "
            "or attest a renderer, establish image-to-PDF visual identity, or review page mappings."
        ],
    }
    if report_kind == "page_index":
        report["marker_pattern"] = MARKER_PATTERN.pattern
    else:
        report.update(render_profile_id=profile, page_image_dpi=dpi)
    _require_output(project_root, output_path, author_root)
    write_json_object(output_path, report)
    return report


def _require_output(project_root: Path, output: Path, author_root: Path) -> None:
    require_owned_output(
        output,
        (project_root / "reports", project_root / "var"),
        (author_root,),
    )
    if output.suffix.lower() != ".json":
        raise FixtureReportError("Fixture report output must be a new JSON file")


def _fixture_entries(contracts: Path) -> list[JsonObject]:
    entries: list[JsonObject] = []
    seen: set[str] = set()
    for name in ("docx-fixture-catalog.json", "native-docx-fixture-catalog.json"):
        path = contracts / name
        _require_input(path, contracts)
        for entry in object_array(load_json_object(path), "fixtures", nonempty=False):
            sample_id = string_value(entry, "sample_id")
            if _SAMPLE_ID.fullmatch(sample_id) is None or sample_id in seen:
                raise FixtureReportError("Fixture sample IDs must be unique kebab-case identifiers")
            seen.add(sample_id)
            hash_value(entry, "sha256")
            string_value(entry, "relative_path")
            entries.append(entry)
    if not entries:
        raise FixtureReportError("Fixture catalogs contain no fixtures")
    return entries


def _render_profile(contracts: Path) -> tuple[str, int]:
    path = contracts / "render-environments.json"
    _require_input(path, contracts)
    profiles = [
        item
        for item in object_array(load_json_object(path), "profiles")
        if item.get("status") != "unavailable"
    ]
    if len(profiles) != 1:
        raise FixtureReportError("Fixture reports require one declared available render profile")
    profile = profiles[0]
    settings = profile.get("required_settings")
    export = settings.get("pdf_export_settings") if isinstance(settings, dict) else None
    dpi = export.get("page_image_dpi") if isinstance(export, dict) else None
    if dpi != 150 or type(dpi) is not int:
        raise FixtureReportError("Fixture image directory requires the declared 150 DPI profile")
    return string_value(profile, "profile_id"), dpi


def _inspect_fixture(
    project_root: Path, fixture: JsonObject, *, include_markers: bool
) -> JsonObject:
    sample_id = string_value(fixture, "sample_id")
    fixture_root = project_root / "tests" / "fixtures" / "docx"
    source = fixture_root / string_value(fixture, "relative_path")
    report_root = project_root / "reports" / "phase0" / "fixtures"
    directory = report_root / sample_id
    pdf = directory / f"{sample_id}.pdf"
    page_directory = directory / "pages-150dpi"
    for path, root in ((source, fixture_root), (pdf, report_root), (page_directory, report_root)):
        require_no_reparse_points(path)
        require_within(path, root)
    source_hash = sha256_file(source) if _optional_file(source) else None
    registered_hash = hash_value(fixture, "sha256")
    if source_hash is not None and source_hash != registered_hash:
        raise FixtureReportError(f"Fixture source hash changed: {sample_id}")
    pdf_hash = sha256_file(pdf) if _optional_file(pdf) else None
    page_count = read_pdf_page_count(pdf) if pdf_hash is not None else None
    if pdf_hash is not None and sha256_file(pdf) != pdf_hash:
        raise FixtureReportError(f"PDF changed during physical inspection: {sample_id}")
    pages = _page_images(page_directory)
    if page_count is not None and any(
        cast(int, page["page_number"]) > page_count for page in pages
    ):
        raise FixtureReportError(f"Page image exceeds the physical PDF page count: {sample_id}")
    missing: list[str] = []
    if source_hash is None:
        missing.append("source")
    if pdf_hash is None:
        missing.append("pdf")
    if not pages or (page_count is not None and len(pages) != page_count):
        missing.append("page_images")
    if (
        not missing
        and page_count is not None
        and {page["page_number"] for page in pages} != set(range(1, page_count + 1))
    ):
        raise FixtureReportError(f"Page image numbers are not contiguous: {sample_id}")
    if include_markers and pdf_hash is not None and page_count is not None:
        by_page = {cast(int, page["page_number"]): page for page in pages}
        for number in range(1, page_count + 1):
            markers = _extract_page_markers(pdf, number)
            if number in by_page:
                by_page[number]["markers"] = markers
        if sha256_file(pdf) != pdf_hash:
            raise FixtureReportError(f"PDF changed during text extraction: {sample_id}")
    if source_hash is not None and sha256_file(source) != source_hash:
        raise FixtureReportError(f"Fixture source changed during evidence inspection: {sample_id}")
    return {
        "sample_id": sample_id,
        "source_path": source.resolve().as_posix(),
        "registered_source_sha256": registered_hash,
        "actual_source_sha256": source_hash,
        "source_hash_matches": source_hash == registered_hash,
        "pdf_path": pdf.resolve().as_posix(),
        "pdf_sha256": pdf_hash,
        "page_directory": page_directory.resolve().as_posix(),
        "page_count": page_count,
        "pages": pages,
        "status": "missing_render_evidence" if missing else "rendered",
        "missing_inputs": missing,
    }


def _page_images(directory: Path) -> list[JsonObject]:
    if not directory.exists():
        return []
    if not directory.is_dir():
        raise FixtureReportError(f"Page image location is not a directory: {directory}")
    pages: dict[int, JsonObject] = {}
    for path in directory.glob("page-*.png"):
        _require_input(path, directory)
        match = _PAGE_NAME.fullmatch(path.name)
        if match is None or int(match.group(1)) < 1:
            raise FixtureReportError(f"Invalid physical page image name: {path.name}")
        number = int(match.group(1))
        if number in pages:
            raise FixtureReportError(f"Duplicate physical page number: {number}")
        captured = path.read_bytes()
        digest = sha256_bytes(captured)
        inspect_png(captured)
        if sha256_file(path) != digest:
            raise FixtureReportError(f"Page image changed while reading: {path}")
        pages[number] = {
            "page_number": number,
            "path": path.resolve().as_posix(),
            "sha256": digest,
            "size": len(captured),
        }
    if pages and set(pages) != set(range(1, max(pages) + 1)):
        raise FixtureReportError("Page image numbers must form a contiguous sequence starting at 1")
    return [pages[number] for number in sorted(pages)]


def _extract_page_markers(pdf: Path, page_number: int) -> list[str]:
    try:
        result = subprocess.run(
            ["pdftotext", "-f", str(page_number), "-l", str(page_number), "-layout", str(pdf), "-"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=_TEXT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError, UnicodeError) as exc:
        raise FixtureReportError(
            f"Cannot inspect PDF text on page {page_number}: {pdf}: {exc}"
        ) from exc
    return sorted(set(MARKER_PATTERN.findall(result.stdout)))


def _page_index_record(record: JsonObject) -> JsonObject:
    pages = [
        {"page_number": page["page_number"], "markers": page.get("markers", [])}
        for page in object_array(record, "pages", nonempty=False)
    ]
    return {
        "sample_id": record["sample_id"],
        "status": "candidate_text_layer_index"
        if record["status"] == "rendered"
        else "missing_render_evidence",
        "pdf_path": record["pdf_path"],
        "pdf_sha256": record["pdf_sha256"],
        "page_count": record["page_count"],
        "pages": pages,
        "missing_inputs": record["missing_inputs"],
        "limitations": [
            "PDF text extraction does not prove formula appearance, image placement "
            "or coordinates.",
            "Independent visual review is required before a mapping is marked verified.",
        ],
    }


def _require_input(path: Path, root: Path) -> None:
    require_no_reparse_points(path)
    require_within(path, root)
    if not path.is_file():
        raise FixtureReportError(f"Required report input is missing: {path}")


def _optional_file(path: Path) -> bool:
    if path.exists() and not path.is_file():
        raise FixtureReportError(f"Expected an input file: {path}")
    return path.is_file()
