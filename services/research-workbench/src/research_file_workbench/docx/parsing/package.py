"""DOCX package inventory, relationships, and unsupported-content records."""

from __future__ import annotations

import posixpath
from xml.etree import ElementTree
from zipfile import ZipFile

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.docx.models import (
    DocxPart,
    DocxReadError,
    DocxRelationship,
    DocxUnsupportedRecord,
    PartStatus,
)
from research_file_workbench.docx.xml_support import (
    DRAWING_MAIN_NAMESPACE,
    MARKUP_COMPATIBILITY_NAMESPACE,
    MATH_NAMESPACE,
    OFFICE_RELATIONSHIP_NAMESPACE,
    WORD_NAMESPACE,
    WORDPROCESSING_DRAWING_NAMESPACE,
    tag_local_name,
)

_CONTENT_TYPES_PATH = "[Content_Types].xml"
_RELATIONSHIP_SUFFIX = ".rels"


def package_part_names(archive: ZipFile) -> tuple[str, ...]:
    """Return unique part names, rejecting ZIP entries with ambiguous identities."""
    names = [item.filename for item in archive.infolist() if not item.is_dir()]
    if len(names) != len(set(names)):
        raise DocxReadError("DOCX package contains duplicate ZIP part names")
    return tuple(sorted(names))


def read_content_types(
    archive: ZipFile, names: tuple[str, ...]
) -> tuple[dict[str, str], list[str]]:
    """Read declared content types and expose malformed declarations as issues."""
    if _CONTENT_TYPES_PATH not in names:
        return {}, ["missing:[Content_Types].xml"]

    try:
        root = ElementTree.fromstring(_read_part_bytes(archive, _CONTENT_TYPES_PATH))
    except (KeyError, ElementTree.ParseError) as exc:
        return {}, [f"failed:[Content_Types].xml:{exc}"]

    defaults: dict[str, str] = {}
    overrides: dict[str, str] = {}
    for element in root:
        kind = tag_local_name(element.tag)
        if kind == "Default":
            extension = element.get("Extension")
            content_type = element.get("ContentType")
            if extension and content_type:
                defaults[extension.casefold()] = content_type
        elif kind == "Override":
            part_name = element.get("PartName")
            content_type = element.get("ContentType")
            if part_name and content_type:
                overrides[_normalize_part_path(part_name.lstrip("/"))] = content_type

    content_types = dict(overrides)
    for name in names:
        content_types.setdefault(name, defaults.get(name.rsplit(".", 1)[-1].casefold(), ""))
    return content_types, []


def inventory_parts(
    archive: ZipFile,
    names: tuple[str, ...],
    content_types: dict[str, str],
) -> tuple[
    tuple[DocxPart, ...],
    dict[str, ElementTree.Element],
    dict[str, bytes],
    list[str],
]:
    """Hash every unique ZIP part and parse available XML with explicit failure records.

    The payload of each successfully parsed XML part is returned alongside its tree, because a
    byte offset is only meaningful against the exact bytes that were parsed.
    """
    parts: list[DocxPart] = []
    xml_roots: dict[str, ElementTree.Element] = {}
    xml_payloads: dict[str, bytes] = {}
    issues: list[str] = []
    for name in names:
        payload = _read_part_bytes(archive, name)
        is_xml = name.casefold().endswith(".xml") or name.casefold().endswith(".rels")
        status: PartStatus = "registered"
        if is_xml:
            try:
                xml_roots[name] = ElementTree.fromstring(payload)
                xml_payloads[name] = payload
                status = "parsed"
            except ElementTree.ParseError as exc:
                status = "failed"
                issues.append(f"failed:{name}:{exc}")
        parts.append(
            DocxPart(
                part_path=name,
                size=len(payload),
                sha256=sha256_bytes(payload),
                content_type=content_types.get(name) or None,
                status=status,
            )
        )
    return tuple(parts), xml_roots, xml_payloads, issues


def _read_part_bytes(archive: ZipFile, name: str) -> bytes:
    """Read one ZIP entry or expose unsupported storage as a typed DOCX refusal."""
    try:
        return archive.read(name)
    except (NotImplementedError, RuntimeError) as exc:
        entry = archive.getinfo(name)
        # ZIP general-purpose bits 0 and 6 mark encrypted and strong-encryption entries.
        if entry.flag_bits & ((1 << 0) | (1 << 6)):
            raise DocxReadError(f"Encrypted DOCX ZIP part is not supported: {name}") from exc
        raise DocxReadError(
            f"Unsupported DOCX ZIP part storage: {name} "
            f"(compression={entry.compress_type}, flags={entry.flag_bits}): {exc}"
        ) from exc


def read_relationships(
    names: tuple[str, ...],
    xml_roots: dict[str, ElementTree.Element],
) -> tuple[tuple[DocxRelationship, ...], list[str]]:
    """Resolve internal relationships only when their target part exists."""
    relationships: list[DocxRelationship] = []
    issues: list[str] = []
    part_names = set(names)
    for name in names:
        if not name.casefold().endswith(_RELATIONSHIP_SUFFIX):
            continue
        root = xml_roots.get(name)
        if root is None:
            continue
        source_part = _relationship_source(name)
        for element in root:
            if tag_local_name(element.tag) != "Relationship":
                continue
            relationship_id = element.get("Id")
            relationship_type = element.get("Type")
            target = element.get("Target")
            if not relationship_id or not relationship_type or target is None:
                issues.append(f"invalid-relationship:{name}")
                continue
            target_mode = element.get("TargetMode")
            resolved_target = _resolve_relationship_target(source_part, target, target_mode)
            if target_mode != "External" and resolved_target not in part_names:
                issues.append(f"unresolved-relationship:{source_part}:{relationship_id}:{target}")
                resolved_target = None
            relationships.append(
                DocxRelationship(
                    source_part=source_part,
                    relationship_id=relationship_id,
                    relationship_type=relationship_type,
                    target=target,
                    target_mode=target_mode,
                    resolved_target=resolved_target,
                )
            )
    relationships_by_part: dict[str, set[str]] = {}
    for relation in relationships:
        relationships_by_part.setdefault(relation.source_part, set()).add(relation.relationship_id)
    for part_path, root in xml_roots.items():
        if part_path.endswith(".rels"):
            continue
        known_ids = relationships_by_part.get(part_path, set())
        for element in root.iter():
            for attribute_name, relationship_id in element.attrib.items():
                if (
                    attribute_name.startswith(f"{{{OFFICE_RELATIONSHIP_NAMESPACE}}}")
                    and relationship_id not in known_ids
                ):
                    issues.append(f"missing-relationship-id:{part_path}:{relationship_id}")
    return tuple(relationships), issues


def read_unsupported_records(
    xml_roots: dict[str, ElementTree.Element],
    relationships: tuple[DocxRelationship, ...],
    issues: tuple[str, ...],
) -> tuple[DocxUnsupportedRecord, ...]:
    """Preserve unsupported package observations and relationship failures for reporting."""
    records: list[DocxUnsupportedRecord] = []
    known_namespaces = {
        WORD_NAMESPACE,
        MATH_NAMESPACE,
        OFFICE_RELATIONSHIP_NAMESPACE,
        MARKUP_COMPATIBILITY_NAMESPACE,
        WORDPROCESSING_DRAWING_NAMESPACE,
        DRAWING_MAIN_NAMESPACE,
    }
    for part_path, root in xml_roots.items():
        if (
            not part_path.startswith("customXml/")
            or part_path.startswith("customXml/_rels/")
            or part_path.casefold().endswith(".rels")
        ):
            continue
        namespace = root.tag.partition("}")[0].lstrip("{")
        if namespace not in known_namespaces:
            incoming = next(
                (relation for relation in relationships if relation.resolved_target == part_path),
                None,
            )
            records.append(
                DocxUnsupportedRecord(
                    source_location=part_path,
                    kind="unknown_namespace",
                    relationship_id=incoming.relationship_id if incoming else None,
                    failure_reason=f"Root namespace is not supported: {namespace or 'none'}",
                    related_part=part_path,
                    parse_status="unsupported",
                    available_page_evidence=(),
                    limitations=(
                        "The part is preserved in the package inventory; semantics are not "
                        "interpreted.",
                    ),
                )
            )
    relation_map = {
        (relation.source_part, relation.relationship_id): relation for relation in relationships
    }
    for issue in issues:
        if issue.startswith("unresolved-relationship:"):
            _, source_part, relationship_id, target = issue.split(":", 3)
            records.append(
                DocxUnsupportedRecord(
                    source_location=source_part,
                    kind="broken_relationship",
                    relationship_id=relationship_id,
                    failure_reason="Internal relationship target is missing from the package.",
                    related_part=target,
                    parse_status="failed",
                    available_page_evidence=(),
                    limitations=("No page mapping is inferred for a broken relationship.",),
                )
            )
        elif issue.startswith("missing-relationship-id:"):
            _, source_part, relationship_id = issue.split(":", 2)
            relation = next(
                (
                    relation
                    for (candidate_source, candidate_id), relation in relation_map.items()
                    if candidate_source == source_part and candidate_id == relationship_id
                ),
                None,
            )
            records.append(
                DocxUnsupportedRecord(
                    source_location=source_part,
                    kind="missing_relationship",
                    relationship_id=relationship_id,
                    failure_reason="The source references a relationship ID that is not declared.",
                    related_part=relation.resolved_target if relation is not None else None,
                    parse_status="failed",
                    available_page_evidence=(),
                    limitations=(),
                )
            )
    return tuple(records)


def _relationship_source(relationship_part: str) -> str:
    if relationship_part == "_rels/.rels":
        return ""
    directory, filename = posixpath.split(relationship_part)
    if not filename.endswith(_RELATIONSHIP_SUFFIX):
        return relationship_part
    source_name = filename[: -len(_RELATIONSHIP_SUFFIX)]
    if directory.endswith("/_rels"):
        directory = directory[: -len("/_rels")]
    return posixpath.join(directory, source_name) if directory else source_name


def _resolve_relationship_target(
    source_part: str, target: str, target_mode: str | None
) -> str | None:
    if target_mode == "External":
        return None
    source_directory = posixpath.dirname(source_part)
    resolved = _normalize_part_path(posixpath.join(source_directory, target))
    if resolved == ".." or resolved.startswith("../"):
        return None
    return resolved


def _normalize_part_path(value: str) -> str:
    normalized = posixpath.normpath(value.replace("\\", "/"))
    return normalized.lstrip("/")
