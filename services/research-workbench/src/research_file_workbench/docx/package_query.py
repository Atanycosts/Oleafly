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
XML_ELEMENT_PATH_VERSION = "xml-element-path-1"
WORKBENCH_XML_CHILD_PATH_VERSION = "workbench-xml-child-path-1"
_NODE_ADDRESS_VERSIONS = {
    XML_ELEMENT_PATH_VERSION,
    WORKBENCH_XML_CHILD_PATH_VERSION,
}


class PackageQueryError(ValueError):
    """Raised when a package query or the selected package facts are invalid."""


class NodeAddressError(PackageQueryError):
    """An address refusal with a message that can be returned without echoing input."""


@dataclass(frozen=True, slots=True)
class _NodeSelector:
    address: _NodeAddress | None
    part: str | None
    namespace_uri: str | None
    local_name: str | None
    attribute_namespace_uri: str | None
    attribute_local_name: str | None
    attribute_value: str | None
    offset: int
    limit: int


@dataclass(frozen=True, slots=True)
class _NodeAddress:
    version: str
    source_sha256: str
    part: str
    path: tuple[int, ...]


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
    source_sha256 = sha256_bytes(content)
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
                "node_address",
            },
        )
        node_selector = _node_selector(query, source_sha256)
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
                        source_sha256,
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


def _node_selector(query: JsonObject, source_sha256: str) -> _NodeSelector:
    address = (
        _node_address(query["node_address"], source_sha256) if "node_address" in query else None
    )
    if address is not None and ({"part", "path"} & set(query)):
        raise NodeAddressError(
            "node_address cannot be combined with top-level part or path; "
            "re-query with only the declared node address"
        )
    if address is None and "path" in query:
        raise NodeAddressError(
            "Top-level path has no declared address source; re-query with node_address using "
            f"{XML_ELEMENT_PATH_VERSION} or {WORKBENCH_XML_CHILD_PATH_VERSION}"
        )

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
        address=address,
        part=None if address is not None else _optional_part(query, "part"),
        namespace_uri=namespace_uri,
        local_name=local_name,
        attribute_namespace_uri=attribute_namespace_uri,
        attribute_local_name=attribute_local_name,
        attribute_value=attribute_value,
        offset=_pagination_value(query, "offset", default=0, maximum=None),
        limit=_pagination_value(query, "limit", default=_DEFAULT_LIMIT, maximum=_MAX_LIMIT),
    )


def _node_address(value: object, source_sha256: str) -> _NodeAddress:
    if not isinstance(value, dict):
        raise NodeAddressError("node_address must be an object")
    address = cast(JsonObject, value)
    if address.keys() != {"version", "source_sha256", "part", "path"}:
        raise NodeAddressError(
            "node_address must contain only version, source_sha256, part and path"
        )
    version = address["version"]
    if not isinstance(version, str) or version not in _NODE_ADDRESS_VERSIONS:
        raise NodeAddressError(
            "Unsupported node_address version; use the version returned with the address"
        )
    address_sha256 = address["source_sha256"]
    if (
        not isinstance(address_sha256, str)
        or len(address_sha256) != 64
        or any(character not in "0123456789abcdef" for character in address_sha256)
    ):
        raise NodeAddressError("node_address.source_sha256 must be a lowercase SHA-256 digest")
    if address_sha256 != source_sha256:
        raise NodeAddressError(
            "Node address was recorded for different DOCX bytes; "
            "select the retained version identified by node_address.source_sha256"
        )
    part = address["part"]
    if not isinstance(part, str) or not part.strip() or "\x00" in part:
        raise NodeAddressError("node_address.part must be an exact package part name")
    path_value = address["path"]
    if not isinstance(path_value, list) or not path_value:
        raise NodeAddressError("node_address.path must be a non-empty integer array")
    if any(type(index) is not int or index < 0 for index in path_value):
        raise NodeAddressError("node_address.path entries must be non-negative integers")
    path = tuple(cast(list[int], path_value))
    if path[0] != 0:
        raise NodeAddressError("node_address.path must start at root index 0")
    return _NodeAddress(version=version, source_sha256=address_sha256, part=part, path=path)


def validate_node_address(
    value: object,
    *,
    source_sha256: str,
    available_parts: set[str],
    allowed_versions: set[str] | None = None,
) -> JsonObject:
    """Validate a retained node address without resolving it against XML again."""
    address = _node_address(value, source_sha256)
    if allowed_versions is not None and address.version not in allowed_versions:
        raise PackageQueryError(f"Unsupported node_address version: {address.version}")
    internal_part = address.part[1:] if address.part.startswith("/") else address.part
    public_part = f"/{internal_part}"
    if (
        not internal_part
        or "\\" in internal_part
        or "\x00" in internal_part
        or any(segment in {"", ".", ".."} for segment in internal_part.split("/"))
        or internal_part not in available_parts
    ):
        raise PackageQueryError(f"Node address part is absent from the package: {address.part}")
    return {
        "version": address.version,
        "source_sha256": address.source_sha256,
        "part": public_part,
        "path": list(address.path),
    }


def _query_nodes(
    archive: ZipFile,
    names: tuple[str, ...],
    canonical_names: dict[str, str],
    content_types: dict[str, str],
    selector: _NodeSelector,
    source_sha256: str,
) -> JsonObject:
    if selector.address is not None:
        return _query_exact_node(
            archive,
            names,
            canonical_names,
            content_types,
            selector,
            source_sha256,
        )
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
        for path, node_path, element, preserve_space in _iter_elements(root, (0,), (0,), False):
            if not _matches_node(
                element,
                selector,
            ):
                continue
            if selector.offset <= total < stop:
                rows.append(
                    _node_record(
                        canonical_names[internal_name],
                        path,
                        node_path,
                        element,
                        preserve_space,
                        source_sha256,
                    )
                )
            total += 1
    return _nodes_page(rows, total=total, offset=selector.offset, limit=selector.limit)


def _query_exact_node(
    archive: ZipFile,
    names: tuple[str, ...],
    canonical_names: dict[str, str],
    content_types: dict[str, str],
    selector: _NodeSelector,
    source_sha256: str,
) -> JsonObject:
    assert selector.address is not None
    try:
        internal_name = _resolve_part(selector.address.part, names)
    except PackageQueryError as exc:
        raise NodeAddressError(
            "Unknown DOCX part in node_address; scan the source package again"
        ) from exc
    if not _is_xml_part(internal_name, content_types.get(internal_name)):
        raise NodeAddressError("The DOCX part in node_address is not XML")
    root = _parse_xml(_read_part_bytes(archive, internal_name), canonical_names[internal_name])
    resolved = _resolve_node_address(root, selector.address)
    element, path, node_path, preserve_space = resolved
    if not _matches_node(element, selector):
        raise NodeAddressError(
            "Node address resolves to a different element than the requested selectors"
        )
    rows = (
        [
            _node_record(
                canonical_names[internal_name],
                path,
                node_path,
                element,
                preserve_space,
                source_sha256,
            )
        ]
        if selector.offset == 0
        else []
    )
    return _nodes_page(rows, total=1, offset=selector.offset, limit=selector.limit)


def _nodes_page(rows: list[JsonObject], *, total: int, offset: int, limit: int) -> JsonObject:
    returned = len(rows)
    has_more = offset + returned < total
    return {
        "nodes": rows,
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": has_more,
        "next_offset": offset + returned if has_more else None,
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
    node_path: tuple[int, ...],
    element: ElementTree.Element,
    preserve_space: bool,
    source_sha256: str,
) -> JsonObject:
    namespace_uri, local_name = _split_xml_name(element.tag)
    return {
        "node_address": xml_element_node_address(source_sha256, part, node_path),
        "part": part,
        "path": list(path),
        "namespace_uri": namespace_uri,
        "local_name": local_name,
        "attributes": [_attribute_record(name, value) for name, value in element.attrib.items()],
        "children": _child_records(path, element, preserve_space),
    }


def xml_element_node_address(source_sha256: str, part: str, path: tuple[int, ...]) -> JsonObject:
    """Describe a physical element in the original XML part of captured DOCX bytes."""
    return {
        "version": XML_ELEMENT_PATH_VERSION,
        "source_sha256": source_sha256,
        "part": f"/{part.lstrip('/')}",
        "path": list(path),
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
    node_path: tuple[int, ...],
    inherited_preserve_space: bool,
) -> Iterator[tuple[tuple[int, ...], tuple[int, ...], ElementTree.Element, bool]]:
    preserve_space = _effective_preserve_space(element, inherited_preserve_space)
    yield path, node_path, element, preserve_space
    index = 0
    if _meaningful_text(element.text, preserve_space):
        index += 1
    for child_index, child in enumerate(element):
        yield from _iter_elements(
            child,
            (*path, index),
            (*node_path, child_index),
            preserve_space,
        )
        index += 1
        if _meaningful_text(child.tail, preserve_space):
            index += 1


def _resolve_node_address(
    root: ElementTree.Element, address: _NodeAddress
) -> tuple[ElementTree.Element, tuple[int, ...], tuple[int, ...], bool]:
    current = root
    mixed_path: tuple[int, ...] = (0,)
    node_path: tuple[int, ...] = (0,)
    preserve_space = _effective_preserve_space(root, False)
    physical_indices = address.version == XML_ELEMENT_PATH_VERSION
    for target_index in address.path[1:]:
        index = 0
        if _meaningful_text(current.text, preserve_space):
            if not physical_indices and target_index == 0:
                raise NodeAddressError("Legacy address points to text, not an XML element")
            index = 1
        found: ElementTree.Element | None = None
        found_mixed_index: int | None = None
        found_physical_index: int | None = None
        for position, child in enumerate(current):
            candidate_index = position if physical_indices else index
            if candidate_index == target_index:
                found = child
                found_mixed_index = index
                found_physical_index = position
                break
            index += 1
            if _meaningful_text(child.tail, preserve_space):
                if not physical_indices and target_index == index:
                    raise NodeAddressError("Legacy address points to text, not an XML element")
                index += 1
        if found is None or found_mixed_index is None or found_physical_index is None:
            raise NodeAddressError("Node address does not exist in the selected XML part")
        mixed_path = (*mixed_path, found_mixed_index)
        node_path = (*node_path, found_physical_index)
        current = found
        preserve_space = _effective_preserve_space(current, preserve_space)
    return current, mixed_path, node_path, preserve_space


def _matches_node(
    element: ElementTree.Element,
    selector: _NodeSelector,
) -> bool:
    namespace_uri, local_name = _split_xml_name(element.tag)
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
