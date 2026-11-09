"""Validation and indexing of independent S1 render and page evidence."""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path

from research_file_workbench.common.filesystem import (
    is_reparse_point,
    require_no_reparse_points,
    require_within,
)
from research_file_workbench.common.hashing import sha256_bytes, sha256_file
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.common.pdf import read_pdf_page_count
from research_file_workbench.common.png import inspect_png
from research_file_workbench.docx.pipeline_errors import S1PipelineError


def validate_render_record(
    render_record: JsonObject,
    source_hash: str,
    application_root: Path,
    *,
    hash_file: Callable[[Path], str] = sha256_file,
    page_count_reader: Callable[[Path], int] = read_pdf_page_count,
) -> None:
    """Validate a process-verified PDF render against the inspected source."""
    if render_record.get("source_sha256") != source_hash:
        raise S1PipelineError("Render record source hash does not match the inspected DOCX")
    if render_record.get("renderer_identity_status") != "process_verified":
        raise S1PipelineError("Render record does not contain process-verified renderer identity")
    output_path = render_record.get("output_path")
    output_sha256 = render_record.get("output_sha256")
    if not isinstance(output_path, str) or not isinstance(output_sha256, str):
        raise S1PipelineError("Render record has no output path and hash")
    output = Path(output_path)
    if not output.is_absolute():
        raise S1PipelineError("Render record output path must be absolute")
    require_no_reparse_points(output)
    require_within(output, application_root)
    if not output.is_file() or hash_file(output) != output_sha256:
        raise S1PipelineError("Render record output is missing or its hash changed")
    count = page_count_reader(output)
    if render_record.get("page_count") is not None and render_record["page_count"] != count:
        raise S1PipelineError("Render record page count differs from the physical PDF")
    render_record["page_count"] = count
    if hash_file(output) != output_sha256:
        raise S1PipelineError("Render PDF changed during inspection")


def validate_page_mapping_report(
    page_report: JsonObject,
    render_report: JsonObject | None,
    page_index: JsonObject | None,
) -> None:
    """Ensure independent page mappings refer to the same render and indexed pages."""
    if render_report is not None:
        if page_report.get("pdf_sha256") != render_report.get("output_sha256"):
            raise S1PipelineError("Page evidence PDF hash does not match the render record")
        if page_report.get("render_profile_id") != render_report.get("render_profile_id"):
            raise S1PipelineError("Page evidence renderer profile does not match the render record")
    if page_index is None:
        return
    page_count = page_index.get("page_count")
    if not isinstance(page_count, int):
        raise S1PipelineError("Page evidence index has no integer page count")
    mappings = page_report.get("mappings")
    if not isinstance(mappings, list):
        raise S1PipelineError("Page mapping report has no mappings array")
    for mapping in mappings:
        if not isinstance(mapping, dict):
            raise S1PipelineError("Page mapping entry is not an object")
        page_numbers = mapping.get("page_numbers")
        if not isinstance(page_numbers, list) or any(
            not isinstance(page, int) or page < 1 or page > page_count for page in page_numbers
        ):
            raise S1PipelineError("Page mapping contains a page outside the indexed range")


def build_page_evidence_index(
    page_directory: Path,
    application_root: Path,
    render_record: JsonObject | None,
    *,
    inspect_png_bytes: Callable[[bytes], object] = inspect_png,
    hash_file: Callable[[Path], str] = sha256_file,
) -> JsonObject:
    """Index application-owned PNG captures without inferring visual semantics."""
    if not page_directory.is_dir():
        raise S1PipelineError(f"Page image directory does not exist: {page_directory}")
    require_within(page_directory, application_root)
    require_no_reparse_points(page_directory)
    page_entries: list[tuple[int, Path, str]] = []
    for page in page_directory.glob("page-*.png"):
        require_within(page, application_root)
        if page.is_symlink() or is_reparse_point(page):
            raise S1PipelineError(f"Page image is a reparse point: {page}")
        content = page.read_bytes()
        inspect_png_bytes(content)
        captured_sha256 = sha256_bytes(content)
        if hash_file(page) != captured_sha256:
            raise S1PipelineError("Page image changed during inspection")
        match = re.fullmatch(r"page-(\d+)\.png", page.name, re.IGNORECASE)
        if match is None:
            raise S1PipelineError(f"Page image name is not canonical: {page.name}")
        page_entries.append((int(match.group(1)), page, captured_sha256))
    page_entries.sort(key=lambda item: item[0])
    if [number for number, _, _ in page_entries] != list(range(1, len(page_entries) + 1)):
        raise S1PipelineError("Page image numbers must be unique and contiguous from 1")
    if render_record is not None:
        declared_page_count = render_record.get("page_count")
        if isinstance(declared_page_count, int) and declared_page_count != len(page_entries):
            raise S1PipelineError("Page image count does not match the render record")
    if not page_entries:
        raise S1PipelineError("Page image directory contains no page-*.png files")
    return {
        "version": "s1-page-evidence-index-1.0.0",
        "status": "unverified",
        "render_profile_id": (
            render_record.get("render_profile_id") if render_record is not None else None
        ),
        "pdf_sha256": render_record.get("output_sha256") if render_record is not None else None,
        "page_count": len(page_entries),
        "pages": [
            {
                "page_number": index,
                "path": page.as_posix(),
                "sha256": digest,
                "parse_status": "unverified",
                "limitations": [
                    "Page appearance is indexed; no object coordinate or semantic mapping is "
                    "inferred."
                ],
            }
            for index, (_, page, digest) in enumerate(page_entries, start=1)
        ],
    }
