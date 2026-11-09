"""Read-only DOCX entry points and parsing-stage coordination."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from research_file_workbench.common.hashing import sha256_bytes, sha256_file
from research_file_workbench.docx.models import (
    DocxReadError,
    DocxReadResult,
)
from research_file_workbench.docx.parsing.content import (
    read_paragraph_scopes,
    read_references,
    read_tables,
    read_text_blocks,
)
from research_file_workbench.docx.parsing.fields import read_fields
from research_file_workbench.docx.parsing.layout import read_layout
from research_file_workbench.docx.parsing.objects import (
    read_complex_objects,
    read_images,
    read_math_objects,
)
from research_file_workbench.docx.parsing.package import (
    inventory_parts,
    package_part_names,
    read_content_types,
    read_relationships,
    read_unsupported_records,
)
from research_file_workbench.docx.parsing.styles import read_numbering, read_styles


def read_docx(path: Path) -> DocxReadResult:
    """Read a DOCX package without modifying the source or creating side files.

    The first slice inventories every ZIP part and relationship, then extracts paragraph
    text from the supported Word regions. It does not infer page locations or semantic
    correctness; malformed XML and unresolved relationships remain visible in ``issues``.
    """
    if not path.is_file():
        raise DocxReadError(f"DOCX source does not exist: {path}")

    source_hash = sha256_file(path)
    payload = path.read_bytes()
    if sha256_bytes(payload) != source_hash or sha256_file(path) != source_hash:
        raise DocxReadError(f"DOCX source changed while reading: {path}")
    result = read_docx_bytes(payload, source_label=path.resolve().as_posix())
    if sha256_file(path) != source_hash:
        raise DocxReadError(f"DOCX source changed while reading: {path}")
    return result


def read_docx_bytes(payload: bytes, *, source_label: str) -> DocxReadResult:
    """Read a captured DOCX version from memory without materializing a writable file."""
    source_sha256 = sha256_bytes(payload)
    try:
        with ZipFile(BytesIO(payload)) as archive:
            names = package_part_names(archive)
            if "word/document.xml" not in names:
                raise DocxReadError(f"DOCX package has no word/document.xml: {source_label}")
            content_types, content_type_issues = read_content_types(archive, names)
            parts, xml_roots, xml_payloads, part_issues = inventory_parts(
                archive, names, content_types
            )
            relationships, relationship_issues = read_relationships(names, xml_roots)
            styles, style_issues = read_styles(xml_roots)
            text_blocks, text_issues = read_text_blocks(
                xml_roots, styles, xml_payloads=xml_payloads
            )
            tables, table_issues = read_tables(xml_roots)
            images, image_issues = read_images(xml_roots, relationships)
            math_objects, math_issues = read_math_objects(xml_roots)
            fields, field_issues = read_fields(xml_roots)
            sections, breaks, layout_issues = read_layout(xml_roots, relationships)
            complex_objects, complex_issues = read_complex_objects(xml_roots, relationships)
            references, reference_issues = read_references(xml_roots, relationships)
            numbering, numbering_issues = read_numbering(xml_roots)
            paragraph_scopes = read_paragraph_scopes(xml_roots)
            issues = tuple(
                content_type_issues
                + part_issues
                + relationship_issues
                + text_issues
                + table_issues
                + image_issues
                + math_issues
                + field_issues
                + layout_issues
                + complex_issues
                + reference_issues
                + style_issues
                + numbering_issues
            )
            unsupported_records = read_unsupported_records(xml_roots, relationships, issues)
    except BadZipFile as exc:
        raise DocxReadError(f"Invalid DOCX ZIP package: {source_label}") from exc

    return DocxReadResult(
        source_path=source_label,
        source_sha256=source_sha256,
        parts=parts,
        relationships=relationships,
        text_blocks=text_blocks,
        tables=tables,
        images=images,
        math_objects=math_objects,
        fields=fields,
        sections=sections,
        breaks=breaks,
        complex_objects=complex_objects,
        references=references,
        styles=styles,
        numbering=numbering,
        unsupported_records=unsupported_records,
        paragraph_scopes=paragraph_scopes,
        issues=issues,
    )
