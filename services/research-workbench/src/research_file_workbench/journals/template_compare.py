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
_EXCLUDED_SECTIONS = {"paragraph_mark", "run_properties", "script_usage"}
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
_TABLE_KINDS = {"table", "tr", "tc"}
_KIND_PAIRED = {"section", *_TABLE_KINDS}
_REGION_ROLES = {"front_matter", "body", "references", "appendix"}
_FIGURE_CAPTION = re.compile(r"^\s*(?:figure|fig\.?|图)\s*[\d一二三四五六七八九十IVXLCDM]", re.I)
_TABLE_CAPTION = re.compile(r"^\s*(?:table|表)\s*[\d一二三四五六七八九十IVXLCDM]", re.I)


class _PropertyProfile(NamedTuple):
    values: tuple[object, ...]
    value_keys: frozenset[str]
    value_count: int
    candidate_count: int
    expressed_count: int
    representatives: tuple[JsonObject, ...]


def compare_template(
    template_snapshot: JsonObject, manuscript_snapshot: JsonObject
) -> list[JsonObject]:
    """Return deterministic findings for effective manuscript format differences."""
    template_objects = _snapshot_objects(template_snapshot)
    manuscript_objects = _snapshot_objects(manuscript_snapshot)
    template_semantics = _semantic_index(template_objects)
    manuscript_semantics = _semantic_index(manuscript_objects)
    template_groups = _template_groups(template_objects, template_semantics)
    profiles = {
        key: _profile_for_templates(templates) for key, templates in template_groups.items()
    }
    merged_profiles: dict[tuple[_ContextKey, ...], _TemplateProfile] = {}
    candidate_cache: dict[_ContextKey, tuple[_ContextKey, ...]] = {}
    findings: list[JsonObject] = []

    for manuscript in manuscript_objects:
        kind = _text(manuscript.get("kind"))
        role = _text(manuscript.get("role"))
        if role == "unknown" and kind not in _KIND_PAIRED:
            findings.append(_unknown_role_finding(manuscript))
            continue
        context = _context_key(manuscript, manuscript_semantics)
        if context not in candidate_cache:
            candidate_cache[context] = _candidate_context_keys(
                manuscript,
                manuscript_semantics,
                template_groups=template_groups,
            )
        context_keys = candidate_cache[context]
        profile = _merged_profile(
            context_keys,
            template_groups=template_groups,
            profiles=profiles,
            cache=merged_profiles,
        )
        if not profile:
            if _selected_leaves(manuscript):
                finding = _unknown_role_finding(manuscript)
                finding["reason"] = "No corresponding template profile"
                findings.append(finding)
            continue

        observed = _selected_leaves(manuscript)
        observed_properties = _properties(manuscript)
        observed_kind = _text(manuscript.get("kind"))
        for path in sorted(profile):
            observed_value = observed.get(path, _MISSING)
            if observed_value is _MISSING and not _path_is_comparable(
                path, observed_kind, observed_properties
            ):
                continue
            property_profile = profile[path]
            variable = (
                property_profile.expressed_count != property_profile.candidate_count
                or property_profile.value_count != 1
            )
            if variable or observed_value is _MISSING:
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
            findings.append(
                _finding(
                    manuscript,
                    property_path=".".join(path),
                    observed=None if observed_value is _MISSING else observed_value,
                    expected=expected,
                    expected_value_count=property_profile.value_count,
                    template_object_ids=[
                        _text(template.get("object_id")) for template in representatives
                    ],
                    template_object_count=property_profile.candidate_count,
                    template_role_basis=_combined_role_basis(representatives),
                    verdict=verdict,
                )
            )
    return findings


def _snapshot_objects(snapshot: JsonObject) -> list[JsonObject]:
    return cast(list[JsonObject], snapshot["objects"])


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
) -> dict[_ContextKey, list[JsonObject]]:
    groups: dict[_ContextKey, list[JsonObject]] = {}
    for obj in objects:
        kind = _text(obj.get("kind"))
        role = _text(obj.get("role"))
        if role == "unknown" and kind not in _KIND_PAIRED:
            continue
        groups.setdefault(_context_key(obj, semantics), []).append(obj)
    return groups


def _context_key(
    obj: JsonObject,
    semantics: dict[int, tuple[int | None, str | None]],
) -> _ContextKey:
    base = _semantic_context_key(obj, semantics)
    region = obj.get("region")
    if isinstance(region, dict) and region.get("role") in _REGION_ROLES:
        return (*base, "region", str(region["role"]))
    return base


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
    obj: JsonObject,
    semantics: dict[int, tuple[int | None, str | None]],
    *,
    template_groups: dict[_ContextKey, list[JsonObject]],
) -> tuple[_ContextKey, ...]:
    base = _semantic_context_key(obj, semantics)
    region = obj.get("region")
    region_role = region.get("role") if isinstance(region, dict) else None
    candidates: list[_ContextKey] = []
    for key in template_groups:
        key_base = key[:-2] if len(key) >= 2 and key[-2] == "region" else key
        if len(base) >= 5 and base[3] == "caption":
            matches = key_base[:4] == base[:4] and (
                base[-1] == "any" or key_base[-1] in {base[-1], "any"}
            )
        else:
            matches = key_base == base
        if matches:
            candidates.append(key)
    if region_role in _REGION_ROLES:
        specific = [key for key in candidates if key[-2:] == ("region", region_role)]
        if specific:
            return tuple(sorted(specific))
        # Old snapshots have no region metadata; keep their common-property behavior.
        return tuple(sorted(key for key in candidates if key[-2:-1] != ("region",)))
    return tuple(sorted(candidates))


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
    flat = _flatten(properties)
    kind = _text(obj.get("kind"))
    return {
        path: value for path, value in flat.items() if _path_is_comparable(path, kind, properties)
    }


def _path_is_comparable(path: _PropertyPath, kind: str, properties: JsonObject) -> bool:
    return (
        not _excluded_path(path)
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
            _text(entry[0].get("object_id")),
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
    return result
