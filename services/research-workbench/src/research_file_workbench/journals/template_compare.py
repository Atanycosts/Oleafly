"""Compare effective DOCX formatting facts with a semantic template."""

from __future__ import annotations

import hashlib
import json
import re
from typing import NamedTuple, cast

from research_file_workbench.common.json_io import JsonObject

type _PropertyPath = tuple[str, ...]
type _ContextKey = tuple[str, ...]
type _TemplateProfile = dict[_PropertyPath, "_PropertyProfile"]

_MISSING = object()
_MAX_EXPECTED_VALUES = 8
_MAX_REPRESENTATIVES = 4
_MAX_ROLE_BASIS = 4
_EXCLUDED_SECTIONS = {
    "paragraph_mark",
    "run_properties",
    "script_usage",
    "table_style",
}
_EXCLUDED_PATHS = {
    ("paragraph", "styleId"),
    ("paragraph", "inheritedRunProperties"),
    ("paragraph", "markRunProperties"),
    ("paragraph", "props"),
    ("paragraph", "available"),
    ("paragraph", "tabStopsCacheToken"),
    ("paragraph", "listItem", "numId"),
    ("paragraph", "listItem", "abstractNumId"),
    ("paragraph", "listItem", "markerText"),
    ("paragraph", "listItem", "ordinal"),
    ("paragraph", "listItem", "cacheToken"),
    ("paragraph", "listItem", "picBullet", "relationshipId"),
    ("paragraph", "listItem", "picBullet", "authored", "picBulletId"),
    ("paragraph", "listItem", "picBullet", "authored", "relationshipId"),
}
_TABLE_STRUCTURE_PATHS = {
    "blocks",
    "cells",
    "columnCount",
    "columnWidthsPt",
    "content",
    "id",
    "rowCount",
    "rows",
    "text",
}
_INTERNAL_LEAF_NAMES = {
    "cacheToken",
    "gridColumnId",
    "id",
    "paragraphPropertyNodes",
    "tabStopsCacheToken",
}
_TABLE_KINDS = {"table", "tr", "tc"}
_KIND_PAIRED = {"section", *_TABLE_KINDS}
_REGION_ROLES = {"front_matter", "body", "references", "appendix"}
_TABLE_CONTEXT_METHODS = {"docx-core-format-snapshot-1.1.0", "docx-core-format-snapshot-1.2.0"}
_TABLE_BAND_SIZE_UNSUPPORTED = "table_band_size_unsupported"
_TABLE_BAND_SIZE_REASON = "Table row or column band sizes other than one are not supported"
_FIGURE_CAPTION = re.compile(r"^\s*(?:figure|fig\.?|图)\s*[\d一二三四五六七八九十IVXLCDM]", re.I)
_TABLE_CAPTION = re.compile(r"^\s*(?:table|表)\s*[\d一二三四五六七八九十IVXLCDM]", re.I)


class _PropertyProfile(NamedTuple):
    values: tuple[object, ...]
    value_keys: frozenset[str]
    value_count: int
    candidate_count: int
    expressed_count: int
    representatives: tuple[JsonObject, ...]


class _TableContext(NamedTuple):
    table_object_id: str
    row_index: int
    row_count: int
    column_index: int | None
    column_count: int | None
    conditions: tuple[str, ...]


def compare_template(
    template_snapshot: JsonObject, manuscript_snapshot: JsonObject
) -> list[JsonObject]:
    """Return deterministic findings for effective manuscript format differences."""
    template_objects = _snapshot_objects(template_snapshot)
    manuscript_objects = _snapshot_objects(manuscript_snapshot)
    template_semantics = _semantic_index(template_objects)
    manuscript_semantics = _semantic_index(manuscript_objects)
    table_context_enabled = _has_table_context_capability(
        template_snapshot
    ) and _has_table_context_capability(manuscript_snapshot)
    table_scoping_enabled = table_context_enabled and _has_table(template_objects)
    template_rows = _table_rows(template_objects) if table_scoping_enabled else {}
    manuscript_rows = _table_rows(manuscript_objects) if table_scoping_enabled else {}
    template_unsupported_tables = _unsupported_table_ids(template_snapshot)
    manuscript_unsupported_tables = _unsupported_table_ids(manuscript_snapshot)
    template_groups = _template_groups(
        template_objects,
        template_semantics,
        table_scoping_enabled=table_scoping_enabled,
        table_rows=template_rows,
    )
    occupied_semantics = {
        _semantic_context_key(obj, template_semantics)
        for obj in template_objects
        if not _is_table_related(obj)
    }
    for key, templates in _style_definition_groups(template_snapshot, occupied_semantics).items():
        if key not in template_groups:
            template_groups[key] = templates
    unsupported_template_keys = {
        key
        for key, templates in template_groups.items()
        if any(_object_table_id(template) in template_unsupported_tables for template in templates)
    }
    profiles = {
        key: _profile_for_templates(templates) for key, templates in template_groups.items()
    }
    merged_profiles: dict[tuple[_ContextKey, ...], _TemplateProfile] = {}
    candidate_cache: dict[_ContextKey, tuple[_ContextKey, ...]] = {}
    findings: list[JsonObject] = []

    for manuscript in manuscript_objects:
        kind = _text(manuscript.get("kind"))
        role = _text(manuscript.get("role"))
        manuscript_band_size_unsupported = (
            _object_table_id(manuscript) in manuscript_unsupported_tables
        )
        if role == "unknown" and kind not in _KIND_PAIRED:
            finding = _unknown_role_finding(manuscript)
            if manuscript_band_size_unsupported:
                finding["reason"] = _TABLE_BAND_SIZE_REASON
            findings.append(finding)
            continue
        if (
            table_context_enabled
            and _requires_table_context(manuscript)
            and not _table_context(manuscript)
        ):
            finding = _unknown_role_finding(manuscript)
            finding["reason"] = (
                _TABLE_BAND_SIZE_REASON
                if manuscript_band_size_unsupported
                else "No corresponding template profile"
            )
            findings.append(finding)
            continue
        context = _context_key(
            manuscript,
            manuscript_semantics,
            table_scoping_enabled=table_scoping_enabled,
            table_rows=manuscript_rows,
        )
        if context not in candidate_cache:
            candidate_cache[context] = _candidate_context_keys(
                context,
                manuscript,
                manuscript_semantics,
                template_groups=template_groups,
            )
        context_keys = candidate_cache[context]
        template_band_size_unsupported = any(
            key in unsupported_template_keys for key in context_keys
        )
        profile = _merged_profile(
            context_keys,
            template_groups=template_groups,
            profiles=profiles,
            cache=merged_profiles,
        )
        if not profile:
            if _selected_leaves(manuscript):
                finding = _unknown_role_finding(manuscript)
                finding["reason"] = (
                    _TABLE_BAND_SIZE_REASON
                    if manuscript_band_size_unsupported or template_band_size_unsupported
                    else "No corresponding template profile"
                )
                findings.append(finding)
            continue

        observed = _selected_leaves(manuscript)
        observed_properties = _properties(manuscript)
        observed_kind = _text(manuscript.get("kind"))
        for path in sorted(profile):
            observed_value = observed.get(path, _MISSING)
            if (
                path[:2] == ("paragraph", "frame")
                and path != ("paragraph", "frame", "present")
                and observed.get(("paragraph", "frame", "present")) is False
            ):
                continue
            if observed_value is _MISSING and not _path_is_comparable(
                path, observed_kind, observed_properties
            ):
                continue
            property_profile = profile[path]
            variable = (
                property_profile.expressed_count != property_profile.candidate_count
                or property_profile.value_count != 1
            )
            if (
                manuscript_band_size_unsupported
                or template_band_size_unsupported
                or variable
                or observed_value is _MISSING
            ):
                verdict = "cannot_determine"
            elif _json_key(observed_value) in property_profile.value_keys:
                verdict = "observed_match"
            elif observed_value is None:
                verdict = "cannot_determine"
            else:
                verdict = "observed_difference"
            expected = (
                property_profile.values[0]
                if property_profile.value_count == 1
                else list(property_profile.values)
            )
            representatives = list(property_profile.representatives)
            finding = _finding(
                manuscript,
                property_path=".".join(path),
                observed=None if observed_value is _MISSING else observed_value,
                expected=expected,
                expected_value_count=property_profile.value_count,
                template_object_ids=[_template_source_id(template) for template in representatives],
                template_object_count=property_profile.candidate_count,
                template_role_basis=_combined_role_basis(representatives),
                verdict=verdict,
            )
            if manuscript_band_size_unsupported or template_band_size_unsupported:
                finding["reason"] = _TABLE_BAND_SIZE_REASON
            findings.append(finding)
    return findings


def _snapshot_objects(snapshot: JsonObject) -> list[JsonObject]:
    return cast(list[JsonObject], snapshot["objects"])


def _has_table(objects: list[JsonObject]) -> bool:
    return any(obj.get("kind") == "table" for obj in objects)


def _unsupported_table_ids(snapshot: JsonObject) -> frozenset[str]:
    unsupported = snapshot.get("unsupported")
    if not isinstance(unsupported, list):
        return frozenset()
    result: set[str] = set()
    for value in unsupported:
        if not isinstance(value, dict):
            continue
        entry = cast(JsonObject, value)
        if entry.get("code") != _TABLE_BAND_SIZE_UNSUPPORTED:
            continue
        object_ids = entry.get("object_ids")
        if isinstance(object_ids, list):
            result.update(value for value in object_ids if isinstance(value, str) and value)
    return frozenset(result)


def _object_table_id(obj: JsonObject) -> str:
    context = obj.get("table_context")
    return (
        _text(cast(JsonObject, context).get("table_object_id")) if isinstance(context, dict) else ""
    )


def _table_rows(objects: list[JsonObject]) -> dict[tuple[str, int], bool]:
    rows: dict[tuple[str, int], bool] = {}
    for obj in objects:
        if obj.get("kind") != "tr":
            continue
        context = _table_context(obj)
        if context is None:
            continue
        row = _properties(obj).get("row")
        is_header = row.get("isHeader") is True if isinstance(row, dict) else False
        rows[(context.table_object_id, context.row_index)] = is_header
    return rows


def _style_definition_groups(
    snapshot: JsonObject,
    occupied_semantics: set[_ContextKey],
) -> dict[_ContextKey, list[JsonObject]]:
    definitions = snapshot.get("style_definitions")
    if not isinstance(definitions, list):
        return {}
    groups: dict[_ContextKey, list[JsonObject]] = {}
    for value in definitions:
        if not isinstance(value, dict):
            continue
        definition = cast(JsonObject, value)
        if definition.get("type") != "paragraph":
            continue
        role = _text(definition.get("role"))
        if role == "unknown":
            continue
        properties = _properties(definition)
        paragraph = properties.get("paragraph")
        outline = paragraph.get("outlineLevel") if isinstance(paragraph, dict) else None
        if role == "heading" and (not isinstance(outline, int) or isinstance(outline, bool)):
            continue
        template = _style_definition_objects(definition)
        for obj in template:
            semantic = _semantic_context_key(obj, {id(obj): (outline, None)})
            if semantic in occupied_semantics:
                continue
            groups.setdefault(semantic, []).append(obj)
    return groups


def _style_definition_objects(definition: JsonObject) -> tuple[JsonObject, JsonObject]:
    role = _text(definition.get("role"))
    role_basis = definition.get("role_basis")
    source_id = _text(definition.get("object_id"))
    properties = _properties(definition)
    common: JsonObject = {
        "object_id": f"style-definition:{source_id}",
        "source_object_id": source_id,
        "part": _text(definition.get("part")),
        "path": definition.get("path") if isinstance(definition.get("path"), list) else [],
        "role": role,
        "role_basis": role_basis if isinstance(role_basis, list) else [],
        "style_definition": True,
    }
    paragraph: JsonObject = {
        **common,
        "kind": "paragraph",
        "properties": {"paragraph": properties.get("paragraph")},
    }
    run: JsonObject = {
        **common,
        "kind": "run",
        "properties": {
            "run": properties.get("run"),
            "script_usage": properties.get("script_usage"),
        },
    }
    return paragraph, run


def _has_table_context_capability(snapshot: JsonObject) -> bool:
    return snapshot.get("method_version") in _TABLE_CONTEXT_METHODS or any(
        isinstance(obj.get("table_context"), dict) for obj in _snapshot_objects(snapshot)
    )


def _is_table_related(obj: JsonObject) -> bool:
    if _text(obj.get("kind")) in _TABLE_KINDS or "table_context" in obj:
        return True
    evidence = obj.get("evidence")
    return isinstance(evidence, dict) and evidence.get("in_table_cell") is True


def _requires_table_context(obj: JsonObject) -> bool:
    return _text(obj.get("kind")) in {"tr", "tc", "paragraph", "run"} and _is_table_related(obj)


def _table_context(obj: JsonObject) -> _TableContext | None:
    value = obj.get("table_context")
    if not isinstance(value, dict):
        return None
    table_object_id = _text(value.get("table_object_id"))
    row_index = _nonnegative_int(value.get("row_index"))
    row_count = _nonnegative_int(value.get("row_count"))
    column_index = _optional_nonnegative_int(value.get("column_index"))
    column_count = _optional_nonnegative_int(value.get("column_count"))
    conditions = value.get("conditions")
    if (
        not table_object_id
        or row_index is None
        or row_count is None
        or row_count < 1
        or row_index >= row_count
        or (column_index is not None and column_count is not None and column_index >= column_count)
        or not isinstance(conditions, list)
        or not all(isinstance(condition, str) and condition for condition in conditions)
    ):
        return None
    aliases = {"firstColumn": "firstCol", "lastColumn": "lastCol"}
    normalized = tuple(
        sorted({aliases.get(condition, condition) for condition in cast(list[str], conditions)})
    )
    return _TableContext(
        table_object_id=table_object_id,
        row_index=row_index,
        row_count=row_count,
        column_index=column_index,
        column_count=column_count,
        conditions=normalized,
    )


def _nonnegative_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _optional_nonnegative_int(value: object) -> int | None:
    return None if value is None else _nonnegative_int(value)


def _semantic_index(objects: list[JsonObject]) -> dict[int, tuple[int | None, str | None]]:
    by_object_id = {
        _text(obj.get("object_id")): obj for obj in objects if _text(obj.get("object_id"))
    }
    result: dict[int, tuple[int | None, str | None]] = {}
    for obj in objects:
        paragraph = by_object_id.get(_paragraph_object_id(obj))
        source = paragraph if paragraph is not None else obj
        result[id(obj)] = (_outline_level(source), _caption_kind(source))
    return result


def _template_groups(
    objects: list[JsonObject],
    semantics: dict[int, tuple[int | None, str | None]],
    *,
    table_scoping_enabled: bool,
    table_rows: dict[tuple[str, int], bool],
) -> dict[_ContextKey, list[JsonObject]]:
    groups: dict[_ContextKey, list[JsonObject]] = {}
    for obj in objects:
        kind = _text(obj.get("kind"))
        role = _text(obj.get("role"))
        if role == "unknown" and kind not in _KIND_PAIRED:
            continue
        groups.setdefault(
            _context_key(
                obj,
                semantics,
                table_scoping_enabled=table_scoping_enabled,
                table_rows=table_rows,
            ),
            [],
        ).append(obj)
    return groups


def _context_key(
    obj: JsonObject,
    semantics: dict[int, tuple[int | None, str | None]],
    *,
    table_scoping_enabled: bool,
    table_rows: dict[tuple[str, int], bool],
) -> _ContextKey:
    base = _semantic_context_key(obj, semantics)
    region = obj.get("region")
    if isinstance(region, dict) and region.get("role") in _REGION_ROLES:
        base = (*base, "region", str(region["role"]))
    table_scope = _table_scope(obj, table_scoping_enabled, table_rows)
    return (*table_scope, *base)


def _table_scope(
    obj: JsonObject,
    table_scoping_enabled: bool,
    table_rows: dict[tuple[str, int], bool],
) -> _ContextKey:
    if not table_scoping_enabled:
        return ()
    if _text(obj.get("kind")) == "table":
        return ("table", "object")
    if not _is_table_related(obj):
        return ()
    context = _table_context(obj)
    if context is None:
        return ("table", "context")
    scope: _ContextKey = ("table", "context")
    if context.conditions:
        return (*scope, "conditions", *context.conditions)
    if _text(obj.get("kind")) in {"tr", "tc", "paragraph", "run"}:
        position = (
            "first"
            if context.row_index == 0
            else "last"
            if context.row_index == context.row_count - 1
            else "middle"
        )
        row = _properties(obj).get("row")
        is_header = (
            row.get("isHeader") is True
            if isinstance(row, dict)
            else table_rows.get((context.table_object_id, context.row_index), False)
        )
        scope = (*scope, "direct", position, "header" if is_header else "body")
    return scope


def _semantic_context_key(
    obj: JsonObject,
    semantics: dict[int, tuple[int | None, str | None]],
) -> _ContextKey:
    kind = _text(obj.get("kind"))
    if kind in _KIND_PAIRED:
        return ("kind", kind)
    role = _text(obj.get("role"))
    outline, caption = semantics[id(obj)]
    if role == "heading":
        level = "missing" if outline is None else str(outline)
        return ("semantic", kind, role, "heading", level)
    if role == "caption":
        return ("semantic", kind, role, "caption", caption or "any")
    return ("semantic", kind, role)


def _candidate_context_keys(
    context: _ContextKey,
    obj: JsonObject,
    semantics: dict[int, tuple[int | None, str | None]],
    *,
    template_groups: dict[_ContextKey, list[JsonObject]],
) -> tuple[_ContextKey, ...]:
    base = _semantic_context_key(obj, semantics)
    region = obj.get("region")
    region_role = region.get("role") if isinstance(region, dict) else None
    table_prefix, _ = _split_table_key(context)
    obj_table_context = _table_context(obj)
    conditions = obj_table_context.conditions if obj_table_context is not None else ()
    candidates: list[_ContextKey] = []
    for key in template_groups:
        key_base = key[:-2] if len(key) >= 2 and key[-2] == "region" else key
        key_table, key_semantic = _split_table_key(key_base)
        if key_table != table_prefix:
            continue
        key_conditions = _conditions_from_table_key(key_table)
        if key_conditions and conditions != tuple(sorted(key_conditions)):
            continue
        if len(base) >= 5 and base[3] == "caption":
            matches = key_semantic[:4] == base[:4] and (
                base[-1] == "any" or key_semantic[-1] in {base[-1], "any"}
            )
        else:
            matches = key_semantic == base
        if matches:
            candidates.append(key)
    if region_role in _REGION_ROLES:
        specific = [key for key in candidates if key[-2:] == ("region", region_role)]
        if specific:
            return tuple(sorted(specific))
        # Old snapshots have no region metadata; keep their common-property behavior.
        return tuple(sorted(key for key in candidates if key[-2:-1] != ("region",)))
    return tuple(sorted(candidates))


def _split_table_key(key: _ContextKey) -> tuple[_ContextKey, _ContextKey]:
    if len(key) < 2 or key[0] != "table":
        return (), key
    if key[2:3] == ("conditions",):
        end = next(
            (index for index in range(3, len(key)) if key[index] in {"kind", "semantic"}),
            len(key),
        )
        return key[:end], key[end:]
    if key[2:3] == ("direct",):
        return key[:5], key[5:]
    return key[:2], key[2:]


def _conditions_from_table_key(key: _ContextKey) -> frozenset[str]:
    if key[2:3] != ("conditions",):
        return frozenset()
    return frozenset(key[3:])


def _merged_profile(
    keys: tuple[_ContextKey, ...],
    *,
    template_groups: dict[_ContextKey, list[JsonObject]],
    profiles: dict[_ContextKey, _TemplateProfile],
    cache: dict[tuple[_ContextKey, ...], _TemplateProfile],
) -> _TemplateProfile:
    if not keys:
        return {}
    if len(keys) == 1:
        return profiles[keys[0]]
    if keys not in cache:
        templates = [template for key in keys for template in template_groups.get(key, [])]
        cache[keys] = _profile_for_templates(templates)
    return cache[keys]


def _profile_for_templates(templates: list[JsonObject]) -> _TemplateProfile:
    values: dict[_PropertyPath, list[tuple[JsonObject, object]]] = {}
    for template in templates:
        for path, value in _selected_leaves(template).items():
            if not _unexpressed_font_slot(path, value):
                values.setdefault(path, []).append((template, value))
    result: _TemplateProfile = {}
    for path, entries in values.items():
        unique_values = _unique_values([value for _template, value in entries])
        representatives = _representatives(entries)
        result[path] = _PropertyProfile(
            values=tuple(unique_values[:_MAX_EXPECTED_VALUES]),
            value_keys=frozenset(_json_key(value) for value in unique_values),
            value_count=len(unique_values),
            candidate_count=len(templates),
            expressed_count=len(entries),
            representatives=representatives,
        )
    return result


def _selected_leaves(obj: JsonObject) -> dict[_PropertyPath, object]:
    properties = cast(JsonObject, obj.get("properties", {}))
    flat = _normalize_frame_leaves(_flatten(properties), properties)
    kind = _text(obj.get("kind"))
    return {
        path: value for path, value in flat.items() if _path_is_comparable(path, kind, properties)
    }


def _normalize_frame_leaves(
    leaves: dict[_PropertyPath, object],
    properties: JsonObject,
) -> dict[_PropertyPath, object]:
    paragraph = properties.get("paragraph")
    if not isinstance(paragraph, dict):
        return leaves
    paragraph = cast(JsonObject, paragraph)
    has_frame_presence = isinstance(paragraph.get("framePresent"), bool)
    if "frame" not in paragraph and not has_frame_presence:
        return leaves
    frame_prefix = ("paragraph", "frame")
    stable = {
        path: value
        for path, value in leaves.items()
        if path[:2] != frame_prefix and path != ("paragraph", "framePresent")
    }
    frame = paragraph.get("frame")
    present = paragraph["framePresent"] if has_frame_presence else frame is not None
    stable[(*frame_prefix, "present")] = present
    if not present:
        return stable
    stable.update(
        {
            path: value
            for path, value in leaves.items()
            if path[:2] == frame_prefix and path != (*frame_prefix, "present")
        }
    )
    return stable


def _path_is_comparable(path: _PropertyPath, kind: str, properties: JsonObject) -> bool:
    return (
        not _excluded_path(path)
        and path[-1] not in _INTERNAL_LEAF_NAMES
        and not (kind in _TABLE_KINDS and path[-1] in _TABLE_STRUCTURE_PATHS)
        and _run_slot_is_used(path, properties)
    )


def _flatten(value: object, prefix: _PropertyPath = ()) -> dict[_PropertyPath, object]:
    if not isinstance(value, dict):
        return {prefix: value} if prefix else {}
    result: dict[_PropertyPath, object] = {}
    for key, child in cast(JsonObject, value).items():
        result.update(_flatten(child, (*prefix, key)))
    return result


def _excluded_path(path: _PropertyPath) -> bool:
    return bool(path) and (
        path[0] in _EXCLUDED_SECTIONS
        or any(path[: len(excluded)] == excluded for excluded in _EXCLUDED_PATHS)
    )


def _run_slot_is_used(path: _PropertyPath, properties: JsonObject) -> bool:
    if not path or path[0] != "run":
        return True
    usage = properties.get("script_usage")
    if not isinstance(usage, dict):
        return path[-1] not in {"fontFamily", "fontFamilyEastAsia"}
    script_usage = cast(JsonObject, usage)
    field = path[-1]
    latin = script_usage.get("latin") is True or script_usage.get("other") is True
    east_asian = script_usage.get("east_asian") is True
    complex_script = script_usage.get("complex") is True
    if "latinLane" in path:
        return east_asian if field == "fontFamilyEastAsia" else latin
    if "complexLane" in path:
        return complex_script
    if field == "fontFamilyEastAsia":
        return east_asian
    if field == "fontFamily":
        return latin or complex_script
    return True


def _unexpressed_font_slot(path: _PropertyPath, value: object) -> bool:
    return value is None and bool(path) and path[-1] in {"fontFamily", "fontFamilyEastAsia"}


def _outline_level(obj: JsonObject) -> int | None:
    properties = _properties(obj)
    paragraph = properties.get("paragraph")
    if not isinstance(paragraph, dict):
        return None
    value = cast(JsonObject, paragraph).get("outlineLevel")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _caption_kind(obj: JsonObject) -> str | None:
    text = _text(obj.get("text"))
    if _FIGURE_CAPTION.match(text):
        return "figure"
    if _TABLE_CAPTION.match(text):
        return "table"
    return None


def _paragraph_object_id(obj: JsonObject) -> str:
    evidence = cast(JsonObject, obj.get("evidence", {}))
    value = evidence.get("paragraph_object_id")
    return value if isinstance(value, str) else ""


def _properties(obj: JsonObject) -> JsonObject:
    value = obj.get("properties")
    return cast(JsonObject, value) if isinstance(value, dict) else {}


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _unique_values(values: list[object]) -> list[object]:
    unique: list[object] = []
    keys: set[str] = set()
    for value in values:
        key = _json_key(value)
        if key not in keys:
            keys.add(key)
            unique.append(value)
    return sorted(unique, key=_json_key)


def _same_json_value(left: object, right: object) -> bool:
    return _json_key(left) == _json_key(right)


def _representatives(
    entries: list[tuple[JsonObject, object]],
) -> tuple[JsonObject, ...]:
    ordered = sorted(
        entries,
        key=lambda entry: (
            _json_key(entry[1]),
            _json_key(_role_basis(entry[0])),
            _template_source_id(entry[0]),
        ),
    )
    result: list[JsonObject] = []
    seen: set[tuple[str, str]] = set()
    for template, value in ordered:
        key = (_json_key(value), _json_key(_role_basis(template)))
        if key in seen:
            continue
        seen.add(key)
        result.append(template)
        if len(result) == _MAX_REPRESENTATIVES:
            break
    return tuple(result)


def _json_key(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def _unknown_role_finding(obj: JsonObject) -> JsonObject:
    return _finding(
        obj,
        property_path="",
        observed=None,
        expected=None,
        expected_value_count=0,
        template_object_ids=[],
        template_object_count=0,
        template_role_basis=[],
        verdict="cannot_determine",
    )


def _role_basis(obj: JsonObject) -> list[JsonObject]:
    value = obj.get("role_basis")
    if not isinstance(value, list):
        return []
    result: dict[str, JsonObject] = {}
    for item in value:
        if not isinstance(item, dict):
            continue
        basis = cast(JsonObject, item)
        if basis.get("source") == "content":
            basis = {key: nested for key, nested in basis.items() if key != "value"}
        result[_json_key(basis)] = basis
    return sorted(result.values(), key=_json_key)[:_MAX_ROLE_BASIS]


def _combined_role_basis(objects: list[JsonObject]) -> list[JsonObject]:
    return sorted(
        {_json_key(basis): basis for obj in objects for basis in _role_basis(obj)}.values(),
        key=_json_key,
    )[:_MAX_ROLE_BASIS]


def _case_id(obj: JsonObject, property_path: str) -> str:
    identity = f"{_text(obj.get('object_id'))}\0{property_path}".encode()
    return f"case-{hashlib.sha256(identity).hexdigest()}"


def _finding(
    obj: JsonObject,
    *,
    property_path: str,
    observed: object,
    expected: object,
    expected_value_count: int,
    template_object_ids: list[str],
    template_object_count: int,
    template_role_basis: list[JsonObject],
    verdict: str,
) -> JsonObject:
    path = obj.get("path")
    result: JsonObject = {
        "case_id": _case_id(obj, property_path),
        "object_id": _text(obj.get("object_id")),
        "kind": _text(obj.get("kind")),
        "role": _text(obj.get("role")),
        "role_basis": _role_basis(obj),
        "part": _text(obj.get("part")),
        "path": list(cast(list[object], path)) if isinstance(path, list) else [],
        "property_path": property_path,
        "observed": observed,
        "expected": expected,
        "expected_value_count": expected_value_count,
        "template_object_ids": template_object_ids,
        "template_object_count": template_object_count,
        "template_role_basis": template_role_basis,
        "verdict": verdict,
    }
    if "region" in obj:
        result["region"] = obj["region"]
    if "table_context" in obj:
        result["table_context"] = obj["table_context"]
    return result


def _template_source_id(template: JsonObject) -> str:
    source_id = _text(template.get("source_object_id"))
    return source_id or _text(template.get("object_id"))
