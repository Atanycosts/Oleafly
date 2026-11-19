"""Bounded, read-only queries over the exact parts and XML trees in a DOCX package."""

from __future__ import annotations

import base64
from collections.abc import Iterator
from dataclasses import dataclass
from io import BytesIO
from typing import cast
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.docx.models import DocxReadError
from research_file_workbench.docx.parsing.package import (
    _read_part_bytes,
    _relationship_source,
    _resolve_relationship_target,
    package_part_names,
    read_content_types,
)

_DEFAULT_LIMIT = 100
_MAX_LIMIT = 1000
_RELATIONSHIP_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"
_XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"


class PackageQueryError(ValueError):
    """Raised when a package query or the selected package facts are invalid."""


@dataclass(frozen=True, slots=True)
class _NodeSelector:
    part: str | None
    path: tuple[int, ...] | None
    namespace_uri: str | None
    local_name: str | None
    attribute_namespace_uri: str | None
    attribute_local_name: str | None
    attribute_value: str | None
    offset: int
    limit: int


@dataclass(frozen=True, slots=True)
class _RelationshipQuery:
    part: str | None
    offset: int
    limit: int


def query_package(content: bytes, query: JsonObject) -> JsonObject:
    """Return one exact raw part, selected XML nodes, or package relationships."""
    if not isinstance(content, bytes):
        raise PackageQueryError("DOCX content must be bytes")
    if not isinstance(query, dict):
        raise PackageQueryError("Package query must be an object")
    operation = _required_text(query.get("operation"), "operation")
    if operation == "part":
        _require_fields(query, {"operation", "part"})
        requested_part = _required_text(query["part"], "part")
        node_selector = None
        relationship_query = None
    elif operation == "nodes":
        _require_fields(
            query,
            {"operation"},
            {
                "part",
                "path",
                "namespace_uri",
                "local_name",
                "attribute",
                "offset",
                "limit",
            },
        )
        node_selector = _node_selector(query)
        requested_part = None
        relationship_query = None
    elif operation == "relationships":
        _require_fields(query, {"operation"}, {"part", "offset", "limit"})
        relationship_query = _RelationshipQuery(
            part=_optional_part(query, "part"),
            offset=_pagination_value(query, "offset", default=0, maximum=None),
            limit=_pagination_value(query, "limit", default=_DEFAULT_LIMIT, maximum=_MAX_LIMIT),
        )
        requested_part = None
    else:
        raise PackageQueryError(f"Unsupported package query operation: {operation}")

    source_sha256 = sha256_bytes(content)
    common: JsonObject = {
        "schema_version": 1,
        "source_sha256": source_sha256,
        "operation": operation,
    }
    try:
        with ZipFile(BytesIO(content)) as archive:
            names = package_part_names(archive)
            _validate_archive_names(names)
            canonical_names = {name: f"/{name}" for name in names}
            content_types, _ = read_content_types(archive, names)
            if operation == "part":
                part = _resolve_part(requested_part or "", names)
                payload = _read_part_bytes(archive, part)
                return {
                    **common,
                    "part": canonical_names[part],
                    "content_base64": base64.b64encode(payload).decode("ascii"),
                    "sha256": sha256_bytes(payload),
                    "byte_length": len(payload),
                    "content_type": content_types.get(part) or None,
                }
            if operation == "nodes":
                assert node_selector is not None
                return {
                    **common,
                    **_query_nodes(
                        archive,
                        names,
                        canonical_names,
                        content_types,
                        node_selector,
                    ),
                }
            assert relationship_query is not None
            return {
                **common,
                **_query_relationships(
                    archive,
                    names,
                    canonical_names,
                    content_types,
                    relationship_query,
                ),
            }
    except BadZipFile as exc:
        raise PackageQueryError("Invalid DOCX ZIP package") from exc
    except DocxReadError as exc:
        raise PackageQueryError(str(exc)) from exc


def _node_selector(query: JsonObject) -> _NodeSelector:
    path_value = query.get("path")
    path: tuple[int, ...] | None = None
    if path_value is not None:
        if not isinstance(path_value, list) or not path_value:
            raise PackageQueryError("path must be a non-empty integer array")
        for index in path_value:
            if type(index) is not int or index < 0:
                raise PackageQueryError("path entries must be non-negative integers")
        path = tuple(cast(list[int], path_value))

    attribute = query.get("attribute")
    attribute_namespace_uri: str | None = None
    attribute_local_name: str | None = None
    attribute_value: str | None = None
    if attribute is not None:
        if not isinstance(attribute, dict):
            raise PackageQueryError("attribute must be an object")
        _require_fields(
            cast(JsonObject, attribute),
            {"local_name"},
            {"namespace_uri", "value"},
        )
        attribute_local_name = _required_text(attribute["local_name"], "attribute.local_name")
        if "namespace_uri" in attribute:
            attribute_namespace_uri = _text(attribute["namespace_uri"], "attribute.namespace_uri")
        if "value" in attribute:
            attribute_value = _text(attribute["value"], "attribute.value")

    namespace_uri = (
        _text(query["namespace_uri"], "namespace_uri") if "namespace_uri" in query else None
    )
    local_name = (
        _required_text(query["local_name"], "local_name") if "local_name" in query else None
    )
    return _NodeSelector(
        part=_optional_part(query, "part"),
        path=path,
        namespace_uri=namespace_uri,
        local_name=local_name,
        attribute_namespace_uri=attribute_namespace_uri,
        attribute_local_name=attribute_local_name,
        attribute_value=attribute_value,
        offset=_pagination_value(query, "offset", default=0, maximum=None),
        limit=_pagination_value(query, "limit", default=_DEFAULT_LIMIT, maximum=_MAX_LIMIT),
    )


def _query_nodes(
    archive: ZipFile,
    names: tuple[str, ...],
    canonical_names: dict[str, str],
    content_types: dict[str, str],
    selector: _NodeSelector,
) -> JsonObject:
    selected_names = (
        (_resolve_part(selector.part, names),)
        if selector.part is not None
        else tuple(name for name in names if _is_xml_part(name, content_types.get(name)))
    )
    rows: list[JsonObject] = []
    total = 0
    stop = selector.offset + selector.limit
    for internal_name in selected_names:
        if not _is_xml_part(internal_name, content_types.get(internal_name)):
            raise PackageQueryError(f"DOCX part is not XML: {canonical_names[internal_name]}")
        root = _parse_xml(_read_part_bytes(archive, internal_name), canonical_names[internal_name])
        if selector.path is not None and selector.part is not None:
            resolved = _resolve_node_path(root, selector.path)
            if resolved == "invalid":
                raise PackageQueryError(
                    f"Node path is outside the selected XML part: {canonical_names[internal_name]}"
                )
        for path, element, preserve_space in _iter_elements(root, (0,), False):
            if not _matches_node(
                canonical_names[internal_name],
                path,
                element,
                selector,
            ):
                continue
            if selector.offset <= total < stop:
                rows.append(
                    _node_record(
                        canonical_names[internal_name],
                        path,
                        element,
                        preserve_space,
                    )
                )
            total += 1
    returned = len(rows)
    has_more = selector.offset + returned < total
    return {
        "nodes": rows,
        "total": total,
        "offset": selector.offset,
        "limit": selector.limit,
        "has_more": has_more,
        "next_offset": selector.offset + returned if has_more else None,
    }


def _query_relationships(
    archive: ZipFile,
    names: tuple[str, ...],
    canonical_names: dict[str, str],
    content_types: dict[str, str],
    query: _RelationshipQuery,
) -> JsonObject:
    owner = ""
    if query.part is not None:
        if query.part == "/":
            owner = ""
        else:
            owner = _resolve_part(query.part, names)
            if owner not in names:
                raise PackageQueryError(f"Unknown DOCX part: {canonical_names.get(owner, owner)}")
    relationship_parts = [
        name
        for name in names
        if name.casefold().endswith(".rels")
        and (query.part is None or _relationship_source(name) == owner)
    ]
    relationships: list[JsonObject] = []
    for relationship_part in relationship_parts:
        root = _parse_xml(
            _read_part_bytes(archive, relationship_part),
            canonical_names[relationship_part],
        )
        relationships.extend(
            _relationship_records(
                relationship_part,
                root,
                names,
                canonical_names,
            )
        )
    relationships.sort(
        key=lambda item: (
            cast(str, item["source_part"]),
            cast(str, item["relationship_part"]),
            cast(str, item["relationship_id"]),
        )
    )
    total = len(relationships)
    rows = relationships[query.offset : query.offset + query.limit]
    returned = len(rows)
    has_more = query.offset + returned < total
    return {
        "relationships": rows,
        "total": total,
        "offset": query.offset,
        "limit": query.limit,
        "has_more": has_more,
        "next_offset": query.offset + returned if has_more else None,
    }


def _relationship_records(
    relationship_part: str,
    root: ElementTree.Element,
    names: tuple[str, ...],
    canonical_names: dict[str, str],
) -> list[JsonObject]:
    namespace_uri, local_name = _split_xml_name(root.tag)
    if local_name != "Relationships" or (
        namespace_uri is not None and namespace_uri != _RELATIONSHIP_NAMESPACE
    ):
        raise PackageQueryError(
            f"Malformed relationship part root: {canonical_names[relationship_part]}"
        )
    source_part = _relationship_source(relationship_part)
    if not source_part:
        source_public = "/"
    elif source_part in canonical_names:
        source_public = canonical_names[source_part]
    else:
        raise PackageQueryError(
            f"Relationship part has no source part: {canonical_names[relationship_part]}"
        )
    part_names = set(names)
    seen_ids: set[str] = set()
    records: list[JsonObject] = []
    for element in root:
        child_namespace, child_name = _split_xml_name(element.tag)
        if child_name != "Relationship" or (
            child_namespace is not None and child_namespace != _RELATIONSHIP_NAMESPACE
        ):
            raise PackageQueryError(
                f"Malformed relationship record in {canonical_names[relationship_part]}"
            )
        relationship_id = _required_text(element.get("Id"), "relationship Id")
        relationship_type = _required_text(element.get("Type"), "relationship Type")
        target = _required_text(element.get("Target"), "relationship Target")
        target_mode = element.get("TargetMode")
        if target_mode not in {None, "External", "Internal"}:
            raise PackageQueryError(f"Unsupported relationship TargetMode: {target_mode}")
        if relationship_id in seen_ids:
            raise PackageQueryError(
                f"Duplicate relationship ID in {canonical_names[relationship_part]}: "
                f"{relationship_id}"
            )
        seen_ids.add(relationship_id)
        resolved_internal = _resolve_relationship_target(source_part, target, target_mode)
        resolved_target = (
            canonical_names[resolved_internal] if resolved_internal in part_names else None
        )
        records.append(
            {
                "relationship_part": canonical_names[relationship_part],
                "source_part": source_public,
                "relationship_id": relationship_id,
                "relationship_type": relationship_type,
                "target": target,
                "target_mode": target_mode,
                "resolved_target": resolved_target,
                "explicit_external": target_mode == "External",
            }
        )
    return records


def _node_record(
    part: str,
    path: tuple[int, ...],
    element: ElementTree.Element,
    preserve_space: bool,
) -> JsonObject:
    namespace_uri, local_name = _split_xml_name(element.tag)
    return {
        "part": part,
        "path": list(path),
        "namespace_uri": namespace_uri,
        "local_name": local_name,
        "attributes": [_attribute_record(name, value) for name, value in element.attrib.items()],
        "children": _child_records(path, element, preserve_space),
    }


def _child_records(
    parent_path: tuple[int, ...],
    element: ElementTree.Element,
    inherited_preserve_space: bool,
) -> list[JsonObject]:
    children: list[JsonObject] = []
    preserve_space = _effective_preserve_space(element, inherited_preserve_space)
    if _meaningful_text(element.text, preserve_space):
        children.append(
            {
                "kind": "text_value",
                "index": 0,
                "path": [*parent_path, 0],
                "value": element.text,
            }
        )
    for child in element:
        index = len(children)
        namespace_uri, local_name = _split_xml_name(child.tag)
        children.append(
            {
                "kind": "element",
                "index": index,
                "path": [*parent_path, index],
                "namespace_uri": namespace_uri,
                "local_name": local_name,
            }
        )
        if _meaningful_text(child.tail, preserve_space):
            children.append(
                {
                    "kind": "text_value",
                    "index": len(children),
                    "path": [*parent_path, len(children)],
                    "value": child.tail,
                }
            )
    return children


def _iter_elements(
    element: ElementTree.Element,
    path: tuple[int, ...],
    inherited_preserve_space: bool,
) -> Iterator[tuple[tuple[int, ...], ElementTree.Element, bool]]:
    preserve_space = _effective_preserve_space(element, inherited_preserve_space)
    yield path, element, preserve_space
    index = 0
    if _meaningful_text(element.text, preserve_space):
        index += 1
    for child in element:
        yield from _iter_elements(child, (*path, index), preserve_space)
        index += 1
        if _meaningful_text(child.tail, preserve_space):
            index += 1


def _resolve_node_path(
    root: ElementTree.Element, path: tuple[int, ...]
) -> ElementTree.Element | str:
    if path[0] != 0:
        return "invalid"
    current = root
    preserve_space = _effective_preserve_space(root, False)
    for child_index in path[1:]:
        index = 0
        if _meaningful_text(current.text, preserve_space):
            if child_index == 0:
                return "text"
            index = 1
        found: ElementTree.Element | None = None
        for child in current:
            if index == child_index:
                found = child
                break
            index += 1
            if _meaningful_text(child.tail, preserve_space):
                if child_index == index:
                    return "text"
                index += 1
        if found is None:
            return "invalid"
        current = found
        preserve_space = _effective_preserve_space(current, preserve_space)
    return current


def _matches_node(
    part: str,
    path: tuple[int, ...],
    element: ElementTree.Element,
    selector: _NodeSelector,
) -> bool:
    namespace_uri, local_name = _split_xml_name(element.tag)
    if selector.part is not None and part != f"/{selector.part.lstrip('/')}":
        return False
    if selector.path is not None and path != selector.path:
        return False
    if selector.namespace_uri is not None and namespace_uri != (selector.namespace_uri or None):
        return False
    if selector.local_name is not None and local_name != selector.local_name:
        return False
    if selector.attribute_local_name is not None:
        matches = False
        for attribute_name, value in element.attrib.items():
            attribute_namespace, attribute_local = _split_xml_name(attribute_name)
            if (
                attribute_local == selector.attribute_local_name
                and (
                    selector.attribute_namespace_uri is None
                    or attribute_namespace == (selector.attribute_namespace_uri or None)
                )
                and (selector.attribute_value is None or value == selector.attribute_value)
            ):
                matches = True
                break
        if not matches:
            return False
    return True


def _attribute_record(name: str, value: str) -> JsonObject:
    namespace_uri, local_name = _split_xml_name(name)
    return {
        "namespace_uri": namespace_uri,
        "local_name": local_name,
        "value": value,
    }


def _split_xml_name(name: str) -> tuple[str | None, str]:
    if not isinstance(name, str):
        raise PackageQueryError("Selected XML contains a non-element node")
    if not name.startswith("{"):
        return None, name
    namespace_uri, separator, local_name = name[1:].partition("}")
    if not separator or not local_name:
        raise PackageQueryError("Selected XML contains an invalid qualified name")
    return namespace_uri, local_name


def _effective_preserve_space(element: ElementTree.Element, inherited_preserve_space: bool) -> bool:
    value = element.get(f"{{{_XML_NAMESPACE}}}space")
    if value == "preserve":
        return True
    if value == "default":
        return False
    return inherited_preserve_space


def _meaningful_text(value: str | None, preserve_space: bool) -> bool:
    return value is not None and bool(value) and (preserve_space or bool(value.strip()))


def _parse_xml(payload: bytes, part: str) -> ElementTree.Element:
    try:
        return ElementTree.fromstring(payload)
    except ElementTree.ParseError as exc:
        raise PackageQueryError(f"Malformed XML part {part}: {exc}") from exc


def _is_xml_part(name: str, content_type: str | None) -> bool:
    lowered = name.casefold()
    return (
        lowered.endswith(".xml")
        or lowered.endswith(".rels")
        or (content_type is not None and "xml" in content_type.casefold())
    )


def _validate_archive_names(names: tuple[str, ...]) -> None:
    for name in names:
        if (
            not name
            or name.startswith("/")
            or "\\" in name
            or "\x00" in name
            or any(segment in {"", ".", ".."} for segment in name.split("/"))
        ):
            raise PackageQueryError(f"DOCX package contains an invalid part name: {name!r}")


def _resolve_part(value: str, names: tuple[str, ...]) -> str:
    value = _required_text(value, "part")
    if "\\" in value or "\x00" in value:
        raise PackageQueryError(f"Invalid DOCX part path: {value}")
    stripped = value[1:] if value.startswith("/") else value
    if (
        not stripped
        or stripped.startswith("/")
        or stripped.endswith("/")
        or any(segment in {"", ".", ".."} for segment in stripped.split("/"))
    ):
        raise PackageQueryError(f"Invalid DOCX part path: {value}")
    if stripped not in names:
        raise PackageQueryError(f"Unknown DOCX part: /{stripped}")
    return stripped


def _optional_part(query: JsonObject, key: str) -> str | None:
    if key not in query:
        return None
    return _required_text(query[key], key)


def _pagination_value(
    query: JsonObject,
    key: str,
    *,
    default: int,
    maximum: int | None,
) -> int:
    if key not in query:
        return default
    value = query[key]
    if type(value) is not int or value < 0:
        raise PackageQueryError(f"{key} must be a non-negative integer")
    if key == "limit" and value == 0:
        raise PackageQueryError("limit must be at least 1")
    if maximum is not None and value > maximum:
        raise PackageQueryError(f"limit must not exceed {maximum}")
    return value


def _require_fields(
    query: JsonObject,
    required: set[str],
    optional: set[str] | None = None,
) -> None:
    missing = required - set(query)
    unknown = set(query) - required - (optional or set())
    if missing:
        raise PackageQueryError(f"Package query is missing fields: {', '.join(sorted(missing))}")
    if unknown:
        raise PackageQueryError(
            f"Package query contains unknown fields: {', '.join(sorted(unknown))}"
        )


def _required_text(value: object, label: str) -> str:
    text = _text(value, label)
    if not text.strip():
        raise PackageQueryError(f"{label} must be nonblank text")
    if "\x00" in text:
        raise PackageQueryError(f"{label} must not contain null characters")
    return text


def _text(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise PackageQueryError(f"{label} must be text")
    return value
