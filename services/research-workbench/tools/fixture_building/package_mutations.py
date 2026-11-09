"""Bounded OOXML package mutations needed by the Phase 0 DOCX fixtures."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from research_file_workbench.common.filesystem import (
    require_no_reparse_points,
    require_owned_output,
)

_CANONICAL_ZIP_TIME = (2026, 1, 1, 0, 0, 0)


class PackageMutationError(RuntimeError):
    """Raised when a requested deterministic OOXML mutation cannot be applied."""


def rewrite_package(
    source_path: Path,
    output_path: Path,
    replacements: Mapping[str, bytes] | None = None,
    removals: frozenset[str] = frozenset(),
) -> None:
    """Rewrite a DOCX with stable ZIP metadata and selected part changes."""
    require_no_reparse_points(source_path)
    require_owned_output(output_path, (output_path.parent,))
    replacement_parts = dict(replacements or {})
    with ZipFile(source_path, "r") as source_archive:
        package_parts = {
            name: source_archive.read(name)
            for name in source_archive.namelist()
            if name not in removals and name not in replacement_parts
        }
    package_parts.update(replacement_parts)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output_path, "x", compression=ZIP_DEFLATED, compresslevel=9) as target_archive:
        for part_name in sorted(package_parts):
            info = ZipInfo(part_name, date_time=_CANONICAL_ZIP_TIME)
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            target_archive.writestr(info, package_parts[part_name])


def mutate_package(
    path: Path,
    mutator: Callable[[dict[str, bytes]], None],
) -> None:
    """Apply one in-place logical mutation through a deterministic temporary package."""
    require_no_reparse_points(path)
    with ZipFile(path, "r") as archive:
        parts = {name: archive.read(name) for name in archive.namelist()}
    mutator(parts)
    temporary_path = path.parent / "b.docx"
    rewrite_package(path, temporary_path, replacements=parts, removals=frozenset(parts))
    temporary_path.replace(path)


def replace_placeholder_paragraph(document_xml: str, placeholder: str, inner_xml: str) -> str:
    """Replace the paragraph containing one unique placeholder with supplied OOXML content."""
    pattern = re.compile(
        rf"<w:p(?P<attrs>[^>]*)>"
        rf"(?P<body>(?:(?!</w:p>).)*?<w:t[^>]*>{re.escape(placeholder)}</w:t>"
        rf"(?:(?!</w:p>).)*?)</w:p>",
        flags=re.DOTALL,
    )
    matches = list(pattern.finditer(document_xml))
    if len(matches) != 1:
        raise PackageMutationError(
            f"Expected one paragraph placeholder {placeholder!r}, found {len(matches)}"
        )
    replacement = f"<w:p{matches[0].group('attrs')}>{inner_xml}</w:p>"
    return pattern.sub(replacement, document_xml, count=1)


def append_relationship(rels_xml: str, relationship_xml: str) -> str:
    """Append one relationship before the package relationship root closes."""
    closing = "</Relationships>"
    if closing not in rels_xml:
        raise PackageMutationError("Relationship document has no closing Relationships element")
    return rels_xml.replace(closing, f"{relationship_xml}{closing}", 1)


def append_content_type_override(content_types_xml: str, override_xml: str) -> str:
    """Append one content-type override before the package root closes."""
    closing = "</Types>"
    if closing not in content_types_xml:
        raise PackageMutationError("Content type document has no closing Types element")
    return content_types_xml.replace(closing, f"{override_xml}{closing}", 1)


def convert_drawing_to_anchor(document_xml: str, marker: str) -> str:
    """Convert the first inline drawing in the marker paragraph to a floating square-wrap anchor."""
    paragraph_pattern = re.compile(
        rf"(<w:p[^>]*>(?:(?!</w:p>).)*?{re.escape(marker)}(?:(?!</w:p>).)*?</w:p>)",
        flags=re.DOTALL,
    )
    match = paragraph_pattern.search(document_xml)
    if match is None:
        raise PackageMutationError(f"Cannot find floating-image marker paragraph {marker!r}")
    paragraph_xml = match.group(1)
    inline_pattern = re.compile(r"<wp:inline(?P<attrs>[^>]*)>(?P<body>.*?)</wp:inline>", re.DOTALL)
    inline_match = inline_pattern.search(paragraph_xml)
    if inline_match is None:
        raise PackageMutationError(f"Marker paragraph {marker!r} has no inline drawing")
    anchor_attributes = (
        ' distT="0" distB="0" distL="114300" distR="114300" simplePos="0" '
        'relativeHeight="251658240" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"'
    )
    namespace_attributes = inline_match.group("attrs")
    anchor_prefix = (
        f"<wp:anchor{namespace_attributes}{anchor_attributes}>"
        '<wp:simplePos x="0" y="0"/>'
        '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>'
        '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>'
    )
    anchor_body = inline_match.group("body")
    extent_match = re.search(r"<wp:extent\b[^>]*/>", anchor_body)
    if extent_match is None:
        raise PackageMutationError(f"Marker paragraph {marker!r} drawing has no extent")
    extent_end = extent_match.end()
    anchor_body = (
        anchor_body[:extent_end]
        + '<wp:wrapSquare wrapText="bothSides"/>'
        + anchor_body[extent_end:]
    )
    anchored = f"{anchor_prefix}{anchor_body}</wp:anchor>"
    updated_paragraph = inline_pattern.sub(anchored, paragraph_xml, count=1)
    return document_xml[: match.start()] + updated_paragraph + document_xml[match.end() :]
