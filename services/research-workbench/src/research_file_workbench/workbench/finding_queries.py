"""Compact author-facing projections over retained template comparison findings."""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from dataclasses import dataclass
from typing import cast

from research_file_workbench.common.json_io import JsonObject

SUMMARY_VERDICTS = ("observed_match", "observed_difference", "cannot_determine")
FINDING_CATEGORIES = (
    "title",
    "heading",
    "body",
    "table",
    "formula",
    "figure",
    "figure_caption",
    "table_caption",
    "references",
    "other",
)
FINDING_ACTIONS = (
    "font",
    "emphasis",
    "line_spacing",
    "paragraph_spacing",
    "indent",
    "alignment",
    "kerning",
    "page_flow",
    "borders",
    "cell_margins",
    "size",
    "numbering",
    "layout",
    "coverage",
    "other",
)
VERIFICATION_TARGET_LIMIT = 500

_PARAGRAPH_ACTIONS = {
    "font",
    "emphasis",
    "line_spacing",
    "paragraph_spacing",
    "indent",
    "alignment",
    "kerning",
    "page_flow",
    "size",
    "numbering",
}
_WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_MATH_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/math"
_TABLE_KINDS = {"table", "tr", "tc"}
_FORMULA_KINDS = {"omath", "omathpara", "equation", "formula"}
_FORMULA_LOCAL_NAMES = {"oMath", "oMathPara"}
_FIGURE_KINDS = {
    "drawing",
    "drawingml",
    "graphic",
    "image",
    "object",
    "pict",
    "picture",
}
_FIGURE_LOCAL_NAMES = {"drawing", "pict", "object"}
_TABLE_HEADER_CONDITIONS = {"firstRow"}
_TABLE_ROUTINE_CONDITIONS = {
    "band1Horz",
    "band2Horz",
    "band1Vert",
    "band2Vert",
    "firstRow",
}
_FIGURE_CAPTION = re.compile(r"^\s*(?:figure|fig\.?|图)\s*[\d一二三四五六七八九十IVXLCDM]", re.I)
_TABLE_CAPTION = re.compile(r"^\s*(?:table|表)\s*[\d一二三四五六七八九十IVXLCDM]", re.I)
_LINE_SPACING_RULE = "paragraph.lineSpacing.rule"
_LINE_SPACING_VALUE = "paragraph.lineSpacing.value"
_CATEGORY_ORDER = {category: index for index, category in enumerate(FINDING_CATEGORIES)}
_ACTION_ORDER = {action: index for index, action in enumerate(FINDING_ACTIONS)}


@dataclass(frozen=True)
class FindingQueryView:
    """Derived, compact grouping for one immutable retained check."""

    check_id: str
    source_sha256: str
    baseline_id: str
    groups: tuple[JsonObject, ...]
    locations_by_group: dict[str, tuple[JsonObject, ...]]
    finding_groups: dict[tuple[str, str, str], str]
    finding_locations: dict[tuple[str, str, str], str]
    group_ids: frozenset[str]
    location_ids: frozenset[str]


@dataclass(frozen=True)
class _ObjectMeta:
    object_id: str
    kind: str
    role: str
    text: str
    paragraph_id: str | None
    para_id: str | None
    table_id: str | None
    table_ordinal: int | None
    table_header: bool
    table_exception: bool
    visual_id: str | None
    visual_ordinal: int | None
    row: int | None
    column: int | None
    section_id: str | None
    heading_level: int | None
    category: str
    order: int


@dataclass
class _GroupState:
    record: JsonObject
    counts: dict[str, int]
    locations: dict[str, _LocationState]
    order: tuple[int, int, int, int, int, str]


@dataclass
class _LocationState:
    record: JsonObject
    counts: dict[str, int]
    order: tuple[int, int, int, str]


class _ObjectIndex:
    """Read only the fields needed to anchor findings without retaining another snapshot."""

    def __init__(self, snapshot: JsonObject) -> None:
        values = snapshot.get("objects")
        objects = [cast(JsonObject, value) for value in values] if isinstance(values, list) else []
        self._by_id = {
            _text(obj.get("object_id")): obj for obj in objects if _text(obj.get("object_id"))
        }
        self._by_path = {
            (_text(obj.get("part")), tuple(_path(obj))): obj
            for obj in objects
            if _text(obj.get("part"))
        }
        self._order = {_text(obj.get("object_id")): index for index, obj in enumerate(objects)}
        self._table_ordinals = {
            _text(obj.get("object_id")): index
            for index, obj in enumerate(
                (candidate for candidate in objects if _text(candidate.get("kind")) == "table"),
                start=1,
            )
        }
        self._visual_cache: dict[str, tuple[str | None, str | None]] = {}
        self._visual_ordinals: dict[tuple[str, str], int] = {}
        visual_counts = {"formula": 0, "figure": 0}
        for obj in objects:
            category = self._visual_category(obj)
            if category is None or self._outer_visual(obj)[1] != _text(obj.get("object_id")):
                continue
            visual_counts[category] += 1
            self._visual_ordinals[(category, _text(obj.get("object_id")))] = visual_counts[category]
        self._header_rows = self._row_headers(objects)
        self._table_paragraphs = self._first_table_paragraphs(objects)
        self._section_paragraphs = self._first_section_paragraphs(objects)

    def meta(self, finding: JsonObject) -> _ObjectMeta:
        object_id = _text(finding.get("object_id"))
        obj = self._by_id.get(object_id)
        if obj is None:
            return self._finding_only_meta(finding)
        paragraph = self._paragraph(obj)
        table_context = _record(finding.get("table_context")) or _record(obj.get("table_context"))
        table_id = (
            _text(table_context.get("table_object_id"))
            if table_context is not None
            else self._table_id(obj)
        )
        row_value = table_context.get("row_index") if table_context is not None else None
        column_value = table_context.get("column_index") if table_context is not None else None
        row = _nonnegative_int(row_value)
        column = _nonnegative_int(column_value)
        text = _text((paragraph or obj).get("text"))
        role = _text(obj.get("role"))
        kind = _text(obj.get("kind"))
        declared = _record(obj.get("declared"))
        namespace_uri = _text(declared.get("namespace_uri")) if declared is not None else ""
        local_name = _text(declared.get("local_name")) if declared is not None else ""
        visual_category, visual_id = self._outer_visual(obj)
        category = _category(
            kind=kind,
            role=role,
            text=text,
            region=_record(obj.get("region")),
            table_id=table_id,
            in_table_cell=_in_table_cell(obj),
            namespace_uri=namespace_uri,
            local_name=local_name,
            visual_category=visual_category,
        )
        section = _record(obj.get("region"))
        section_id = (
            _text(section.get("section_object_id"))
            if section is not None
            else object_id
            if kind == "section"
            else None
        )
        conditions = _table_conditions(table_context)
        table_header = bool(
            table_id is not None
            and (
                (row is not None and self._header_rows.get((table_id, row), False))
                or conditions & _TABLE_HEADER_CONDITIONS
            )
        )
        table_exception = _table_context_exception(table_context)
        return _ObjectMeta(
            object_id=object_id,
            kind=kind,
            role=role,
            text=text,
            paragraph_id=_text((paragraph or {}).get("object_id")) or None,
            para_id=_para_id(paragraph) if paragraph is not None else None,
            table_id=table_id or None,
            table_ordinal=self._table_ordinals.get(table_id) if table_id else None,
            table_header=table_header,
            table_exception=table_exception,
            visual_id=visual_id,
            visual_ordinal=self._visual_ordinals.get((visual_category, visual_id))
            if visual_id and visual_category is not None
            else None,
            row=row + 1 if row is not None else None,
            column=column + 1 if column is not None else None,
            section_id=section_id or None,
            heading_level=_outline_level(paragraph) if category == "heading" else None,
            category=category,
            order=self._order.get(object_id, len(self._order)),
        )

    def section_para(self, section_id: str) -> tuple[str | None, str]:
        return self._section_paragraphs.get(section_id, (None, ""))

    def first_table_paragraph(self, object_id: str) -> JsonObject | None:
        return self._table_paragraphs.get(object_id)

    def anchor_object(self, object_id: str) -> JsonObject | None:
        return self._by_id.get(object_id)

    def order_of(self, object_id: str, default: int) -> int:
        return self._order.get(object_id, default)

    def _outer_visual(self, obj: JsonObject) -> tuple[str | None, str | None]:
        object_id = _text(obj.get("object_id"))
        cached = self._visual_cache.get(object_id)
        if cached is not None:
            return cached
        part = _text(obj.get("part"))
        path = _path(obj)
        result: tuple[str | None, str | None] = (None, None)
        for length in range(1, len(path) + 1):
            candidate = self._by_path.get((part, tuple(path[:length])))
            if candidate is None:
                continue
            category = self._visual_category(candidate)
            if category is not None:
                result = (category, _text(candidate.get("object_id")))
                self._visual_cache[object_id] = result
                return result
        self._visual_cache[object_id] = result
        return result

    @staticmethod
    def _visual_category(obj: JsonObject) -> str | None:
        declared = _record(obj.get("declared"))
        namespace_uri = _text(declared.get("namespace_uri")) if declared is not None else ""
        local_name = _text(declared.get("local_name")) if declared is not None else ""
        kind = _text(obj.get("kind")).lower()
        if namespace_uri == _MATH_NAMESPACE and local_name in _FORMULA_LOCAL_NAMES:
            return "formula"
        if kind in _FORMULA_KINDS:
            return "formula"
        if kind in _FIGURE_KINDS:
            return "figure"
        if namespace_uri == _WORD_NAMESPACE and local_name in _FIGURE_LOCAL_NAMES:
            return "figure"
        return None

    def _paragraph(self, obj: JsonObject) -> JsonObject | None:
        if _text(obj.get("kind")) == "paragraph":
            return obj
        evidence = _record(obj.get("evidence"))
        owner_id = _text(evidence.get("paragraph_object_id")) if evidence is not None else ""
        if owner_id:
            owner = self._by_id.get(owner_id)
            if owner is not None and _text(owner.get("kind")) == "paragraph":
                return owner
        return self._ancestor(obj, "paragraph")

    def _table_id(self, obj: JsonObject) -> str:
        if _text(obj.get("kind")) == "table":
            return _text(obj.get("object_id"))
        table = self._ancestor(obj, "table")
        return _text(table.get("object_id")) if table is not None else ""

    def _ancestor(self, obj: JsonObject, kind: str) -> JsonObject | None:
        part = _text(obj.get("part"))
        path = _path(obj)
        for length in range(len(path), -1, -1):
            candidate = self._by_path.get((part, tuple(path[:length])))
            if candidate is not None and _text(candidate.get("kind")) == kind:
                return candidate
        return None

    def _finding_only_meta(self, finding: JsonObject) -> _ObjectMeta:
        role_basis = finding.get("role_basis")
        level = _outline_basis(role_basis if isinstance(role_basis, list) else [])
        table_context = _record(finding.get("table_context"))
        table_id = _text(table_context.get("table_object_id")) if table_context else ""
        row = _nonnegative_int(table_context.get("row_index")) if table_context else None
        column = _nonnegative_int(table_context.get("column_index")) if table_context else None
        kind = _text(finding.get("kind"))
        role = _text(finding.get("role"))
        conditions = _table_conditions(table_context)
        region = _record(finding.get("region"))
        category = _category(
            kind=kind,
            role=role,
            text="",
            region=region,
            table_id=table_id,
            in_table_cell=table_context is not None,
            namespace_uri="",
            local_name="",
            visual_category=None,
        )
        return _ObjectMeta(
            object_id=_text(finding.get("object_id")),
            kind=kind,
            role=role,
            text="",
            paragraph_id=None,
            para_id=None,
            table_id=table_id or None,
            table_ordinal=self._table_ordinals.get(table_id) if table_id else None,
            table_header=bool(table_id and conditions & _TABLE_HEADER_CONDITIONS),
            table_exception=_table_context_exception(table_context),
            visual_id=None,
            visual_ordinal=None,
            row=row + 1 if row is not None else None,
            column=column + 1 if column is not None else None,
            section_id=(_text(region.get("section_object_id")) if region is not None else None),
            heading_level=level if category == "heading" else None,
            category=category,
            order=len(self._order),
        )

    @staticmethod
    def _row_headers(objects: list[JsonObject]) -> dict[tuple[str, int], bool]:
        rows: dict[tuple[str, int], bool] = {}
        for obj in objects:
            context = _record(obj.get("table_context"))
            if _text(obj.get("kind")) != "tr" or context is None:
                continue
            row = _nonnegative_int(context.get("row_index"))
            table_id = _text(context.get("table_object_id"))
            properties = _record(obj.get("properties"))
            row_properties = _record(properties.get("row")) if properties is not None else None
            if row is not None and table_id and row_properties is not None:
                rows[(table_id, row)] = row_properties.get("isHeader") is True
        return rows

    @staticmethod
    def _first_section_paragraphs(
        objects: list[JsonObject],
    ) -> dict[str, tuple[str, str]]:
        result: dict[str, tuple[str, str]] = {}
        for obj in objects:
            if _text(obj.get("kind")) != "paragraph":
                continue
            region = _record(obj.get("region"))
            section_id = _text(region.get("section_object_id")) if region is not None else ""
            if section_id and section_id not in result:
                result[section_id] = (_para_id(obj) or "", _text(obj.get("text")))
        return result

    @staticmethod
    def _first_table_paragraphs(objects: list[JsonObject]) -> dict[str, JsonObject]:
        containers = {
            (_text(obj.get("part")), tuple(_path(obj))): _text(obj.get("object_id"))
            for obj in objects
            if _text(obj.get("kind")).lower() in _TABLE_KINDS
        }
        result: dict[str, JsonObject] = {}
        for obj in objects:
            if _text(obj.get("kind")) != "paragraph" or _para_id(obj) is None:
                continue
            part = _text(obj.get("part"))
            path = _path(obj)
            for length in range(1, len(path) + 1):
                container_id = containers.get((part, tuple(path[:length])))
                if container_id:
                    result.setdefault(container_id, obj)
        return result


def build_finding_query_view(
    check: JsonObject, snapshot: JsonObject, findings: list[JsonObject]
) -> FindingQueryView:
    """Project one retained findings page into stable groups and locations."""
    index = _ObjectIndex(snapshot)
    groups: dict[str, _GroupState] = {}
    finding_groups: dict[tuple[str, str, str], str] = {}
    finding_locations: dict[tuple[str, str, str], str] = {}
    overall = _empty_counts()

    for finding in findings:
        key = _finding_key(finding)
        verdict = _text(finding.get("verdict"))
        _increment(overall, verdict)
        meta = index.meta(finding)
        action = _action(_text(finding.get("property_path")))
        table_area = _table_area(meta) if meta.category == "table" else None
        visual_id = meta.visual_id or "" if meta.category in {"formula", "figure"} else ""
        group_key = "|".join(
            (
                meta.category,
                action,
                "" if meta.heading_level is None else str(meta.heading_level),
                meta.table_id or "",
                table_area or "",
                visual_id,
            )
        )
        group_id = _stable_id("group", _text(check.get("check_id")), group_key)
        group = groups.get(group_id)
        if group is None:
            record: JsonObject = {
                "id": group_id,
                "category": meta.category,
                "action": action,
                "counts": _empty_counts(),
                "location_count": 0,
            }
            if meta.heading_level is not None:
                record["heading_level"] = meta.heading_level
            object_number = (
                meta.table_ordinal
                if meta.category == "table"
                else meta.visual_ordinal
                if meta.category in {"formula", "figure"}
                else None
            )
            if object_number is not None:
                record["object_number"] = object_number
            if meta.category == "table" and table_area is not None:
                record["table_area"] = table_area
            group = _GroupState(
                record=record,
                counts=_counts_ref(record),
                locations={},
                order=(
                    _CATEGORY_ORDER[meta.category],
                    _ACTION_ORDER[action],
                    meta.heading_level if meta.heading_level is not None else -1,
                    meta.table_ordinal or meta.visual_ordinal or 0,
                    _TABLE_AREA_ORDER.get(table_area or "", -1),
                    group_id,
                ),
            )
            groups[group_id] = group
        _increment(group.counts, verdict)

        location_id, location, location_order, label, para_id, row, column = _location(
            finding=finding,
            meta=meta,
            action=action,
            group_id=group_id,
            index=index,
        )
        existing = group.locations.get(location_id)
        if existing is None:
            record = {
                "id": location_id,
                "counts": _empty_counts(),
            }
            if label:
                record["label"] = label
            if para_id:
                record["para_id"] = para_id
            object_number = (
                meta.table_ordinal
                if meta.category == "table"
                else meta.visual_ordinal
                if meta.category in {"formula", "figure"}
                else None
            )
            if object_number is not None:
                record["object_number"] = object_number
            if row is not None:
                record["row"] = row
            if column is not None:
                record["column"] = column
            existing = _LocationState(
                record=record,
                counts=_counts_ref(record),
                order=location_order,
            )
            group.locations[location_id] = existing
            group.record["location_count"] = cast(int, group.record["location_count"]) + 1
        _increment(existing.counts, verdict)
        finding_groups[key] = group_id
        finding_locations[key] = location_id

    ordered_groups = tuple(
        state.record for state in sorted(groups.values(), key=lambda state: state.order)
    )
    locations_by_group = {
        group_id: tuple(
            state.record
            for state in sorted(group.locations.values(), key=lambda state: state.order)
        )
        for group_id, group in groups.items()
    }
    return FindingQueryView(
        check_id=_text(check.get("check_id")),
        source_sha256=_text(check.get("source_sha256")),
        baseline_id=_text(check.get("baseline_id")),
        groups=ordered_groups,
        locations_by_group=locations_by_group,
        finding_groups=finding_groups,
        finding_locations=finding_locations,
        group_ids=frozenset(groups),
        location_ids=frozenset(finding_locations.values()),
    )


def finding_groups_result(view: FindingQueryView, findings: list[JsonObject]) -> JsonObject:
    totals = _empty_counts()
    for finding in findings:
        _increment(totals, _text(finding.get("verdict")))
    return {
        "schema_version": 1,
        "operation": "finding_groups",
        "check_id": view.check_id,
        "baseline_id": view.baseline_id,
        "source_sha256": view.source_sha256,
        "groups": list(view.groups),
        "summary": {
            "group_count": len(view.groups),
            "location_count": sum(cast(int, group["location_count"]) for group in view.groups),
            "finding_count": len(findings),
            "counts": totals,
        },
    }


def remaining_review_groups(view: FindingQueryView, findings: list[JsonObject]) -> list[JsonObject]:
    """Keep unresolved groups and one exact evidence location per unresolved verdict."""
    locations = {
        location["id"]: location
        for entries in view.locations_by_group.values()
        for location in entries
    }
    examples: dict[str, dict[str, JsonObject]] = defaultdict(dict)
    for finding in findings:
        verdict = str(finding["verdict"])
        if verdict not in {"observed_difference", "cannot_determine"}:
            continue
        key = _finding_key(finding)
        group_examples = examples[view.finding_groups[key]]
        if verdict in group_examples:
            continue
        location = locations[view.finding_locations[key]]
        group_examples[verdict] = {
            **{
                field: finding[field]
                for field in (
                    "case_id",
                    "object_id",
                    "part",
                    "property_path",
                    "observed",
                    "expected",
                    "template_object_ids",
                    "node_address",
                    "reason",
                )
                if field in finding
            },
            "location": {field: value for field, value in location.items() if field != "counts"},
        }
    return [
        {**group, "examples": examples[str(group["id"])]}
        for group in view.groups
        if str(group["id"]) in examples
    ]


def finding_locations_result(
    view: FindingQueryView,
    *,
    group_id: str,
    verdict: str | None,
    offset: int,
    limit: int,
) -> JsonObject:
    if group_id not in view.group_ids:
        raise ValueError("Finding group does not belong to the selected check")
    if verdict is not None and verdict not in SUMMARY_VERDICTS:
        raise ValueError("Finding location verdict must be a supported comparison verdict")
    locations = view.locations_by_group[group_id]
    if verdict is not None:
        locations = tuple(
            location
            for location in locations
            if cast(int, cast(JsonObject, location["counts"])[verdict]) > 0
        )
    end = min(offset + limit, len(locations))
    return {
        "schema_version": 1,
        "operation": "finding_locations",
        "check_id": view.check_id,
        "baseline_id": view.baseline_id,
        "source_sha256": view.source_sha256,
        "group_id": group_id,
        "locations": list(locations[offset:end]),
        "total": len(locations),
        "has_more": end < len(locations),
        "next_offset": end if end < len(locations) else None,
    }


def with_line_spacing_rules(
    findings: list[JsonObject], retained: list[JsonObject]
) -> list[JsonObject]:
    """Attach the same paragraph object's retained line-spacing rule to its numeric value."""
    rules: dict[tuple[str, str], JsonObject] = {}
    for finding in retained:
        if _text(finding.get("property_path")) != _LINE_SPACING_RULE:
            continue
        key = (_text(finding.get("part")), _text(finding.get("object_id")))
        rules.setdefault(
            key,
            {
                "observed": finding.get("observed"),
                "expected": finding.get("expected"),
            },
        )
    projected: list[JsonObject] = []
    for finding in findings:
        rule = rules.get((_text(finding.get("part")), _text(finding.get("object_id"))))
        if _text(finding.get("property_path")) != _LINE_SPACING_VALUE or rule is None:
            projected.append(finding)
        else:
            projected.append({**finding, "line_spacing_rule": rule})
    return projected


def filter_finding_records(
    findings: list[JsonObject],
    view: FindingQueryView,
    *,
    group_id: str | None,
    location_id: str | None,
) -> list[JsonObject]:
    if group_id is not None and group_id not in view.group_ids:
        raise ValueError("Finding group does not belong to the selected check")
    if location_id is not None and location_id not in view.location_ids:
        raise ValueError("Finding location does not belong to the selected check")
    return [
        finding
        for finding in findings
        if (group_id is None or view.finding_groups.get(_finding_key(finding)) == group_id)
        and (
            location_id is None or view.finding_locations.get(_finding_key(finding)) == location_id
        )
    ]


def candidate_findings_result(
    check: JsonObject,
    findings: list[JsonObject],
    *,
    property_paths: list[str],
    offset: int,
    limit: int,
) -> JsonObject:
    requested = set(property_paths)
    selected = [
        finding
        for finding in findings
        if finding.get("verdict") == "observed_difference"
        and _text(finding.get("property_path")) in requested
        and "reason" not in finding
        and finding.get("expected_value_count") == 1
        and not _table_finding(finding)
    ]
    end = min(offset + limit, len(selected))
    return {
        "schema_version": 1,
        "operation": "candidate_findings",
        "check_id": _text(check.get("check_id")),
        "baseline_id": _text(check.get("baseline_id")),
        "source_sha256": _text(check.get("source_sha256")),
        "findings": [_candidate_projection(finding) for finding in selected[offset:end]],
        "total": len(selected),
        "has_more": end < len(selected),
        "next_offset": end if end < len(selected) else None,
    }


def finding_verification_result(
    check: JsonObject,
    findings: list[JsonObject],
    targets: list[JsonObject],
) -> JsonObject:
    exact: dict[tuple[str, str], list[JsonObject]] = defaultdict(list)
    by_object: dict[tuple[str, str], list[JsonObject]] = defaultdict(list)
    for finding in findings:
        property_path = _text(finding.get("property_path"))
        exact[(_text(finding.get("case_id")), property_path)].append(finding)
        by_object[(_text(finding.get("object_id")), property_path)].append(finding)

    matched: dict[tuple[str, str, str], JsonObject] = {}
    for target in targets:
        case_id = _text(target.get("case_id"))
        property_path = _text(target.get("property_path"))
        object_ids = cast(list[str], target["object_ids"])
        for finding in exact.get((case_id, property_path), []):
            matched[_finding_key(finding)] = finding
        for object_id in object_ids:
            for finding in by_object.get((object_id, property_path), []):
                matched[_finding_key(finding)] = finding

    projected = [_verification_projection(finding) for finding in matched.values()]
    projected.sort(
        key=lambda item: (str(item["case_id"]), str(item["object_id"]), str(item["property_path"]))
    )
    return {
        "schema_version": 1,
        "operation": "finding_verification",
        "check_id": _text(check.get("check_id")),
        "baseline_id": _text(check.get("baseline_id")),
        "source_sha256": _text(check.get("source_sha256")),
        "findings": projected,
        "total": len(projected),
        "target_limit": VERIFICATION_TARGET_LIMIT,
    }


def validate_pagination(payload: JsonObject, *, default_limit: int = 100) -> tuple[int, int]:
    offset = payload.get("offset", 0)
    limit = payload.get("limit", default_limit)
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 1000:
        raise ValueError("Query pagination requires offset >= 0 and limit 1..1000")
    return offset, limit


def validate_verification_targets(value: object) -> list[JsonObject]:
    if not isinstance(value, list) or not 1 <= len(value) <= VERIFICATION_TARGET_LIMIT:
        raise ValueError("Finding verification requires 1..500 targets")
    targets: list[JsonObject] = []
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("Finding verification target must be an object")
        target = cast(JsonObject, raw)
        if set(target) != {"case_id", "property_path", "object_ids"}:
            raise ValueError("Finding verification target fields are incomplete")
        if not isinstance(target["case_id"], str) or not target["case_id"].strip():
            raise ValueError("Finding verification target needs a nonblank case ID")
        if not isinstance(target["property_path"], str):
            raise ValueError("Finding verification target needs a property path string")
        object_ids = target["object_ids"]
        if not isinstance(object_ids, list) or any(
            not isinstance(object_id, str) or not object_id.strip() for object_id in object_ids
        ):
            raise ValueError("Finding verification target object_ids must be nonblank strings")
        targets.append(
            {
                "case_id": target["case_id"],
                "property_path": target["property_path"],
                "object_ids": list(dict.fromkeys(object_ids)),
            }
        )
    return targets


def _location(
    *,
    finding: JsonObject,
    meta: _ObjectMeta,
    action: str,
    group_id: str,
    index: _ObjectIndex,
) -> tuple[str, JsonObject, tuple[int, int, int, str], str, str | None, int | None, int | None]:
    anchor_id = meta.object_id
    label = meta.text
    para_id = meta.para_id
    order = meta.order
    if meta.category in {"formula", "figure"}:
        anchor_id = meta.visual_id or meta.object_id
    elif meta.kind in {"paragraph", "run"} and meta.paragraph_id is not None:
        anchor_id = meta.paragraph_id
        order = index.order_of(anchor_id, order)
        paragraph = index.anchor_object(anchor_id)
        if paragraph is not None:
            label = _text(paragraph.get("text"))
            para_id = _para_id(paragraph)
    elif meta.category == "table":
        paragraph = (
            index.first_table_paragraph(meta.object_id)
            if meta.kind in {"table", "tr", "tc"}
            else None
        )
        if paragraph is not None:
            anchor_id = _text(paragraph.get("object_id"))
            order = index.order_of(anchor_id, order)
            label = _text(paragraph.get("text"))
            para_id = _para_id(paragraph)
        elif meta.kind in {"table", "tr", "tc"}:
            anchor_id = meta.object_id
            anchor = index.anchor_object(anchor_id)
            label = _text(anchor.get("text")) if anchor is not None else label
            para_id = None
        elif meta.paragraph_id is not None:
            anchor_id = meta.paragraph_id
            order = index.order_of(anchor_id, order)
        elif meta.table_id is not None:
            anchor_id = meta.table_id
            anchor = index.anchor_object(anchor_id)
            label = _text(anchor.get("text")) if anchor is not None else label
            para_id = None
    elif meta.kind == "section" and meta.section_id is not None:
        anchor_id = meta.section_id
        section_para, section_label = index.section_para(anchor_id)
        para_id = section_para
        label = section_label
    elif meta.paragraph_id is not None and (
        action in _PARAGRAPH_ACTIONS or meta.kind in {"paragraph", "run"}
    ):
        anchor_id = meta.paragraph_id
        order = index.order_of(anchor_id, order)
    location_id = _stable_id("location", group_id, anchor_id)
    return (
        location_id,
        {"id": location_id},
        (order, meta.row or 0, meta.column or 0, location_id),
        label,
        para_id,
        meta.row,
        meta.column,
    )


def _category(
    *,
    kind: str,
    role: str,
    text: str,
    region: JsonObject | None,
    table_id: str,
    in_table_cell: bool,
    namespace_uri: str,
    local_name: str,
    visual_category: str | None,
) -> str:
    normalized_kind = kind.lower()
    if visual_category is not None:
        return visual_category
    if table_id or normalized_kind in _TABLE_KINDS or in_table_cell:
        return "table"
    if namespace_uri == _MATH_NAMESPACE and local_name in _FORMULA_LOCAL_NAMES:
        return "formula"
    if normalized_kind in _FORMULA_KINDS:
        return "formula"
    if namespace_uri == _WORD_NAMESPACE and local_name in _FIGURE_LOCAL_NAMES:
        return "figure"
    if normalized_kind in _FIGURE_KINDS:
        return "figure"
    if role == "caption":
        if _FIGURE_CAPTION.match(text):
            return "figure_caption"
        if _TABLE_CAPTION.match(text):
            return "table_caption"
        return "other"
    if role == "document_title":
        return "title"
    if role in {"heading", "abstract_heading"}:
        return "heading"
    if role == "reference" or (region is not None and region.get("role") == "references"):
        return "references"
    if role in {"body", "abstract", "author", "affiliation", "keywords"}:
        return "body"
    if kind == "section" and region is not None:
        if region.get("role") == "references":
            return "references"
        if region.get("role") == "body":
            return "body"
    return "other"


def _action(property_path: str) -> str:
    if not property_path:
        return "coverage"
    lowered = property_path.lower()
    leaf = lowered.rsplit(".", 1)[-1]
    if leaf == "fontsizept":
        return "size"
    if "fontfamily" in leaf:
        return "font"
    if leaf in {
        "bold",
        "italic",
        "underline",
        "strike",
        "dstrike",
        "caps",
        "smallcaps",
        "allcaps",
        "emboss",
        "imprint",
    }:
        return "emphasis"
    if leaf in {"kerning", "kerningenabled", "kerningminpt"}:
        return "kerning"
    if "linespacing" in lowered or leaf in {"line", "linerule", "linespacing"}:
        return "line_spacing"
    if leaf in {"before", "after", "beforelines", "afterlines"}:
        return "paragraph_spacing"
    if "indent" in lowered:
        return "indent"
    if leaf in {"alignment", "justification"}:
        return "alignment"
    if leaf in {
        "keepnext",
        "keeplines",
        "widowcontrol",
        "pagebreakbefore",
        "break",
        "snaptogrid",
    } or lowered in {"row.cantsplit", "row.isheader"}:
        return "page_flow"
    if "border" in lowered:
        return "borders"
    if lowered.startswith("cell.") and "margin" in lowered:
        return "cell_margins"
    if "numbering" in lowered or "listitem" in lowered or lowered.startswith("paragraph.list."):
        return "numbering"
    if (
        lowered.startswith("section.")
        or lowered.startswith("table.")
        or lowered.startswith("row.")
        or lowered.startswith("cell.width")
        or lowered.startswith("paragraph.frame.")
        or any(
            part in lowered for part in ("width", "height", "column", "layout", "position", "wrap")
        )
    ):
        return "layout"
    return "other"


def _table_area(meta: _ObjectMeta) -> str | None:
    if meta.kind == "table":
        return None
    if meta.table_header:
        return "header"
    return "exception" if meta.table_exception else "body"


def _table_context_exception(table_context: JsonObject | None) -> bool:
    return bool(_table_conditions(table_context) - _TABLE_ROUTINE_CONDITIONS)


def _table_conditions(table_context: JsonObject | None) -> set[str]:
    conditions = table_context.get("conditions") if table_context is not None else None
    if not isinstance(conditions, list):
        return set()
    return {condition for condition in conditions if isinstance(condition, str) and condition}


def _candidate_projection(finding: JsonObject) -> JsonObject:
    path = finding.get("path")
    projected: JsonObject = {
        "case_id": finding.get("case_id"),
        "object_id": finding.get("object_id"),
        "kind": finding.get("kind"),
        "role": finding.get("role"),
        "part": finding.get("part"),
        "path": list(path) if isinstance(path, list) else [],
        "property_path": finding.get("property_path"),
        "verdict": "observed_difference",
        "observed": finding.get("observed"),
        "expected": finding.get("expected"),
        "expected_value_count": 1,
        "template_object_ids": list(
            cast(list[object], finding.get("template_object_ids", []))
            if isinstance(finding.get("template_object_ids"), list)
            else []
        ),
    }
    if isinstance(finding.get("template_object_count"), int):
        projected["template_object_count"] = finding["template_object_count"]
    return projected


def _verification_projection(finding: JsonObject) -> JsonObject:
    projected: JsonObject = {
        "case_id": finding.get("case_id"),
        "object_id": finding.get("object_id"),
        "property_path": finding.get("property_path"),
        "verdict": finding.get("verdict"),
    }
    observed = finding.get("observed")
    if observed is None or isinstance(observed, (str, int, float, bool)):
        projected["observed"] = observed
    return projected


def _table_finding(finding: JsonObject) -> bool:
    return (
        isinstance(finding.get("table_context"), dict) or _text(finding.get("kind")) in _TABLE_KINDS
    )


def _finding_key(finding: JsonObject) -> tuple[str, str, str]:
    return (
        _text(finding.get("case_id")),
        _text(finding.get("object_id")),
        _text(finding.get("property_path")),
    )


def _empty_counts() -> dict[str, int]:
    return {verdict: 0 for verdict in SUMMARY_VERDICTS}


def _counts_ref(record: JsonObject) -> dict[str, int]:
    return cast(dict[str, int], record["counts"])


def _increment(counts: dict[str, int], verdict: str) -> None:
    if verdict in counts:
        counts[verdict] += 1


def _stable_id(prefix: str, *parts: str) -> str:
    digest = hashlib.sha256("\0".join(parts).encode()).hexdigest()[:32]
    return f"{prefix}-{digest}"


def _outline_level(paragraph: JsonObject | None) -> int | None:
    if paragraph is None:
        return None
    properties = _record(paragraph.get("properties"))
    paragraph_properties = _record(properties.get("paragraph")) if properties is not None else None
    value = paragraph_properties.get("outlineLevel") if paragraph_properties is not None else None
    return value + 1 if isinstance(value, int) and not isinstance(value, bool) else None


def _outline_basis(values: list[object]) -> int | None:
    for value in values:
        basis = _record(value)
        if basis is None or basis.get("source") != "outline_level":
            continue
        raw = basis.get("value")
        if isinstance(raw, int) and not isinstance(raw, bool):
            return raw + 1
        if isinstance(raw, str) and raw.isdigit():
            return int(raw) + 1
    return None


def _para_id(paragraph: JsonObject | None) -> str | None:
    declared = _record(paragraph.get("declared")) if paragraph is not None else None
    attributes = declared.get("attributes") if declared is not None else None
    if not isinstance(attributes, list):
        return None
    for raw in attributes:
        attribute = _record(raw)
        if attribute is not None and attribute.get("localName") == "paraId":
            value = attribute.get("value")
            if isinstance(value, str) and value:
                return value
    return None


def _in_table_cell(obj: JsonObject) -> bool:
    evidence = _record(obj.get("evidence"))
    return evidence is not None and evidence.get("in_table_cell") is True


def _path(obj: JsonObject) -> list[int]:
    value = obj.get("path")
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, int) and not isinstance(item, bool)]


def _record(value: object) -> JsonObject | None:
    return cast(JsonObject, value) if isinstance(value, dict) else None


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _nonnegative_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


_TABLE_AREA_ORDER = {"header": 0, "body": 1, "exception": 2}


__all__ = [
    "FINDING_ACTIONS",
    "FINDING_CATEGORIES",
    "FindingQueryView",
    "VERIFICATION_TARGET_LIMIT",
    "build_finding_query_view",
    "candidate_findings_result",
    "filter_finding_records",
    "finding_groups_result",
    "finding_locations_result",
    "finding_verification_result",
    "with_line_spacing_rules",
    "validate_pagination",
    "validate_verification_targets",
]
