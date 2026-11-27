"""Project-bound style specifications from the current retained template snapshot."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast

from research_file_workbench.common.json_io import JsonObject, encode_json_object
from research_file_workbench.journals.models import (
    require_keys,
    require_object,
    require_objects,
    require_text,
)
from research_file_workbench.workbench.http_boundary import optional_text, text

DEFAULT_LIMIT = 10
MAX_LIMIT = 50

TemplateStylesStatus = Literal["available", "unbound", "template_unavailable"]

_REQUEST_OPTIONAL_FIELDS = {
    "role",
    "heading_level",
    "style_id",
    "offset",
    "limit",
    "expected_binding_id",
}
_EVIDENCE_FIELDS = (
    "style_chain",
    "character_style_chain",
    "paragraph_style_id",
    "paragraph_object_id",
)
_PARAGRAPH_INTERNALS = {
    "props",
    "inheritedRunProperties",
    "markRunProperties",
    "tabStopsCacheToken",
}


@dataclass(frozen=True)
class TemplateStylesQuery:
    """One validated, project-bound style page request."""

    project_id: str
    role: str | None
    heading_level: int | None
    style_id: str | None
    offset: int
    limit: int
    expected_binding_id: str | None


def parse_template_styles_query(payload: JsonObject, target: JsonObject) -> TemplateStylesQuery:
    """Validate the project-only target and bounded style selectors at the HTTP boundary."""
    require_keys(payload, {"target", "operation"}, _REQUEST_OPTIONAL_FIELDS)
    require_keys(target, {"project_id"})
    expected_binding_id = optional_text(payload, "expected_binding_id")
    offset = payload.get("offset", 0)
    limit = payload.get("limit", DEFAULT_LIMIT)
    if type(offset) is not int or offset < 0:
        raise ValueError("Template style offset must be a nonnegative integer")
    if type(limit) is not int or not 1 <= limit <= MAX_LIMIT:
        raise ValueError(f"Template style limit must be 1..{MAX_LIMIT}")
    if offset > 0 and expected_binding_id is None:
        raise ValueError("Template style pages after the first require expected_binding_id")

    heading_level = payload.get("heading_level")
    if heading_level is not None and (
        type(heading_level) is not int or not 1 <= heading_level <= 9
    ):
        raise ValueError("Template style heading_level must be 1..9")
    return TemplateStylesQuery(
        project_id=text(target, "project_id"),
        role=optional_text(payload, "role"),
        heading_level=heading_level,
        style_id=optional_text(payload, "style_id"),
        offset=offset,
        limit=limit,
        expected_binding_id=expected_binding_id,
    )


def compact_binding(binding: JsonObject | None) -> JsonObject | None:
    """Retain the exact version pin without exposing storage or actor metadata."""
    if binding is None:
        return None
    previous_binding_id = binding.get("previous_binding_id")
    return {
        "binding_id": require_text(binding.get("binding_id"), "binding ID"),
        "world_version_id": require_text(binding.get("world_version_id"), "binding world version"),
        "baseline_id": require_text(binding.get("baseline_id"), "binding baseline"),
        "previous_binding_id": (
            require_text(previous_binding_id, "previous binding ID")
            if previous_binding_id is not None
            else None
        ),
    }


def build_template_styles_result(
    query: TemplateStylesQuery,
    status: TemplateStylesStatus,
    binding: JsonObject | None,
    snapshot: JsonObject | None,
) -> JsonObject:
    """Page declarations and actual examples independently of declaration coverage."""
    definitions = []
    examples: list[JsonObject] = []
    source_sha256 = None
    if snapshot is not None:
        source_sha256 = snapshot["source_sha256"]
        for style in require_objects(snapshot.get("style_definitions", []), "style definitions"):
            level = _heading_level(style)
            if _matches_scope(style, level, query) and (
                query.style_id is None or query.style_id == style["style_id"]
            ):
                definitions.append(_style_result(style, level))
        examples = _example_variants(require_objects(snapshot["objects"], "objects"), query)
    total = len(definitions) + len(examples)
    end = min(query.offset + query.limit, total)
    return {
        "schema_version": 1,
        "operation": "template_styles",
        "project_id": query.project_id,
        "status": status,
        "binding": compact_binding(binding),
        "source_sha256": source_sha256,
        "styles": definitions[query.offset : end],
        "examples": examples[
            max(0, query.offset - len(definitions)) : max(0, end - len(definitions))
        ],
        "style_total": len(definitions),
        "example_variant_total": len(examples),
        "total": total,
        "has_more": end < total,
        "next_offset": end if end < total else None,
    }


def _matches_scope(value: JsonObject, level: int | None, query: TemplateStylesQuery) -> bool:
    return (query.role is None or value["role"] == query.role) and (
        query.heading_level is None or level == query.heading_level
    )


def _style_result(style: JsonObject, level: int | None) -> JsonObject:
    result: JsonObject = {
        key: style[key]
        for key in (
            "object_id",
            "part",
            "path",
            "style_id",
            "name",
            "type",
            "based_on",
            "role",
            "role_basis",
            "node_address",
            "effective_status",
            "declared",
        )
        if key in style
    }
    result["computed"] = _effective(style)
    if level is not None:
        result["heading_level"] = level
    return result


def _example_variants(objects: list[JsonObject], query: TemplateStylesQuery) -> list[JsonObject]:
    paragraphs = {item["object_id"]: item for item in objects if item["kind"] == "paragraph"}
    variants: dict[str, JsonObject] = {}
    for item in objects:
        content = item.get("text")
        if (
            item["kind"] not in ("paragraph", "run")
            or not isinstance(content, str)
            or not content.strip()
        ):
            continue
        evidence = require_object(item["evidence"], "template example evidence")
        paragraph_id = evidence.get("paragraph_object_id")
        paragraph = paragraphs.get(paragraph_id, item) if isinstance(paragraph_id, str) else item
        level = _heading_level(paragraph)
        if not _matches_scope(paragraph, level, query):
            continue
        style_id = item.get("style_id")
        paragraph_style = paragraph.get("style_id") or evidence.get("paragraph_style_id")
        if query.style_id is not None and query.style_id not in (style_id, paragraph_style):
            continue
        facts: JsonObject = {
            "part": item["part"],
            "kind": item["kind"],
            "role": paragraph["role"],
            "heading_level": level,
            "style_id": style_id,
            "paragraph_style_id": paragraph_style,
            "region_role": _record(paragraph.get("region")).get("role"),
            "inside_table": _record(paragraph.get("evidence")).get("in_table_cell") is True,
            "properties": _effective(item),
        }
        key = encode_json_object(facts)
        if key in variants:
            variants[key]["count"] = cast(int, variants[key]["count"]) + 1
            continue
        variants[key] = {
            **facts,
            "count": 1,
            "object_id": item["object_id"],
            "path": item["path"],
            **({"node_address": item["node_address"]} if "node_address" in item else {}),
            "role_basis": paragraph["role_basis"],
            "evidence": {key: evidence[key] for key in _EVIDENCE_FIELDS if key in evidence},
        }
    return list(variants.values())


def _effective(item: JsonObject) -> JsonObject:
    properties = require_object(item["properties"], "effective style facts")
    result = {
        key: properties[key]
        for key in ("run", "paragraph_mark", "script_usage")
        if key in properties
    }
    if "paragraph" in properties:
        paragraph = require_object(properties["paragraph"], "effective paragraph")
        result["paragraph"] = {
            key: value for key, value in paragraph.items() if key not in _PARAGRAPH_INTERNALS
        }
    return result


def _heading_level(value: JsonObject) -> int | None:
    if value["role"] != "heading":
        return None
    paragraph = _record(_record(value.get("properties")).get("paragraph"))
    outline = paragraph.get("outlineLevel")
    if type(outline) is int and 0 <= outline <= 8:
        return outline + 1
    for raw in require_objects(value.get("role_basis"), "role basis"):
        if raw.get("source") != "outline_level":
            continue
        basis = raw.get("value")
        if isinstance(basis, int) and not isinstance(basis, bool) and 0 <= basis <= 8:
            return basis + 1
        if isinstance(basis, str) and basis.isdigit() and 0 <= int(basis) <= 8:
            return int(basis) + 1
    return None


def _record(value: object) -> JsonObject:
    return cast(JsonObject, value) if isinstance(value, dict) else {}
