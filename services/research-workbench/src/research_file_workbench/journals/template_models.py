"""Source-bound core snapshots and explicitly selected template worlds."""

from __future__ import annotations

from io import BytesIO
from typing import cast
from zipfile import ZipFile

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.docx.format_snapshot import (
    FORMAT_SNAPSHOT_METHOD_VERSION,
    format_snapshot_method,
)
from research_file_workbench.docx.parsing.package import package_part_names
from research_file_workbench.journals.models import (
    WorldAnalysisError,
    record_digest,
    require_keys,
    require_object,
    require_objects,
    require_text,
)

TEMPLATE_ANALYZER_VERSION = "docx-template-analyzer-1.3.0"
TEMPLATE_CHECKER_VERSION = "docx-template-checker-1.1.0"
SNAPSHOT_METHOD = FORMAT_SNAPSHOT_METHOD_VERSION


def validate_snapshot(
    snapshot: JsonObject, content: bytes, *, require_current: bool = False
) -> None:
    """Validate captured facts against the retained package, without recomputing core semantics."""
    require_keys(
        snapshot,
        {
            "schema_version",
            "source_sha256",
            "engine",
            "parts",
            "objects",
            "capabilities",
            "unsupported",
        },
        {"method_version", "style_definitions"},
    )
    method = format_snapshot_method(snapshot)
    if require_current and method != SNAPSHOT_METHOD:
        raise WorldAnalysisError("DOCX format reader changed; recapture format facts")
    if method == SNAPSHOT_METHOD and "style_definitions" not in snapshot:
        raise WorldAnalysisError("Current format snapshots must include style definitions")
    if type(snapshot["schema_version"]) is not int or snapshot["schema_version"] != 1:
        raise WorldAnalysisError("Unsupported core format snapshot schema")
    if snapshot["source_sha256"] != sha256_bytes(content):
        raise WorldAnalysisError("Format snapshot source hash differs from retained bytes")
    engine = require_object(snapshot["engine"], "snapshot engine")
    require_keys(engine, {"name", "version"})
    if engine["name"] != "@docx-editor.dev/core":
        raise WorldAnalysisError("Format snapshots must use the application DOCX core")
    require_text(engine["version"], "core version")
    parts = require_objects(snapshot["parts"], "snapshot parts", nonempty=True)
    with ZipFile(BytesIO(content)) as archive:
        actual = {"/" + name: archive.read(name) for name in package_part_names(archive)}
    seen: set[str] = set()
    for part in parts:
        name = require_text(part.get("name"), "part name")
        if name in seen or name not in actual:
            raise WorldAnalysisError("Snapshot has duplicate or absent package parts")
        seen.add(name)
        if part.get("sha256") != sha256_bytes(actual[name]) or part.get("byte_length") != len(
            actual[name]
        ):
            raise WorldAnalysisError("Snapshot part bytes differ from retained package")
    if seen != set(actual):
        raise WorldAnalysisError("Snapshot must account for every package entry")
    ids: set[str] = set()
    objects = require_objects(snapshot["objects"], "snapshot objects")
    for item in objects:
        identity = require_text(item.get("object_id"), "object ID")
        if identity in ids or item.get("part") not in seen:
            raise WorldAnalysisError("Snapshot object identity or part is invalid")
        ids.add(identity)
        expected_id = _canonical_locator(item)
        path = item["path"]
        evidence = require_object(item["evidence"], "evidence")
        section_context = evidence.get("core_section")
        section_index = section_context.get("index") if isinstance(section_context, dict) else None
        implicit_ids = {str(item["part"]) + "#implicit-section"}
        if type(section_index) is int and section_index >= 0:
            implicit_ids.add(str(item["part"]) + f"#implicit-section-{section_index}")
        implicit_section = (
            item.get("kind") == "section"
            and path == []
            and evidence.get("implicit") is True
            and identity in implicit_ids
        )
        if identity != expected_id and not implicit_section:
            raise WorldAnalysisError("Snapshot object ID differs from its canonical path")
        for field in ("kind", "role"):
            require_text(item.get(field), field)
        for field in ("properties", "declared", "evidence"):
            require_object(item.get(field), field)
        require_objects(item.get("role_basis"), "role basis")
        if "region" in item:
            region = require_object(item["region"], "object region")
            require_keys(region, {"section_object_id", "role", "role_basis"})
            require_text(region["section_object_id"], "region section object ID")
            if region["role"] not in {
                "front_matter",
                "body",
                "references",
                "appendix",
                "mixed",
                "unknown",
            }:
                raise WorldAnalysisError("Unknown document region role")
            require_objects(region["role_basis"], "region role basis")
    tables = {str(item["object_id"]): item for item in objects if item["kind"] == "table"}
    for item in objects:
        if (
            "region" in item
            and require_object(item["region"], "region")["section_object_id"] not in ids
        ):
            raise WorldAnalysisError("Region identifies an absent section object")
        if "table_context" in item:
            _validate_table_context(item, tables)
    style_ids: set[str] = set()
    for style in require_objects(snapshot.get("style_definitions", []), "style definitions"):
        require_keys(
            style,
            {
                "style_id",
                "name",
                "type",
                "based_on",
                "part",
                "path",
                "object_id",
                "role",
                "role_basis",
                "properties",
            },
            {"declared", "effective_status"},
        )
        style_id = require_text(style["style_id"], "style ID")
        if style_id in style_ids or style["object_id"] in ids:
            raise WorldAnalysisError("Snapshot has duplicate style identities")
        style_ids.add(style_id)
        ids.add(require_text(style["object_id"], "style object ID"))
        if style["part"] not in seen or style["object_id"] != _canonical_locator(style):
            raise WorldAnalysisError("Style definition differs from its canonical package locator")
        style_type = require_text(style["type"], "style type")
        if method != SNAPSHOT_METHOD and style_type != "paragraph":
            raise WorldAnalysisError("Effective style definitions must be paragraph styles")
        if "declared" in style:
            require_object(style["declared"], "declared style")
        if "effective_status" in style:
            expected_status = {"paragraph": "paragraph_and_run", "character": "run"}.get(
                style_type, "declaration_only"
            )
            if style["effective_status"] != expected_status:
                raise WorldAnalysisError("Style effective status differs from its type")
        for field in ("name", "based_on"):
            if style[field] is not None:
                require_text(style[field], f"style {field}")
        require_text(style["role"], "style role")
        require_objects(style["role_basis"], "style role basis")
        effective = require_object(style["properties"], "style properties")
        for field in ("paragraph", "run", "script_usage"):
            require_object(effective.get(field), f"effective style {field}")
    require_object(snapshot["capabilities"], "snapshot capabilities")
    require_objects(snapshot["unsupported"], "snapshot unsupported")
    encode_json_object(snapshot)


def _canonical_locator(item: JsonObject) -> str:
    path = item.get("path")
    if not isinstance(path, list) or any(type(value) is not int or value < 0 for value in path):
        raise WorldAnalysisError("Snapshot paths must contain nonnegative child indices")
    return str(item["part"]) + "#" + ".".join(str(index) for index in path)


def _validate_table_context(item: JsonObject, tables: dict[str, JsonObject]) -> None:
    context = require_object(item["table_context"], "table context")
    require_keys(
        context,
        {"table_object_id", "row_count", "conditions"},
        {"row_index", "column_index", "column_count"},
    )
    table_id = require_text(context["table_object_id"], "context table object ID")
    if table_id not in tables or tables[table_id]["part"] != item["part"]:
        raise WorldAnalysisError("Table context identifies an absent source-local table")
    table_path = cast(list[int], tables[table_id]["path"])
    object_path = cast(list[int], item["path"])
    if object_path[: len(table_path)] != table_path:
        raise WorldAnalysisError("Table context identifies a different component")
    for field in ("row_count", "column_count", "row_index", "column_index"):
        if field in context and (type(context[field]) is not int or cast(int, context[field]) < 0):
            raise WorldAnalysisError(
                "Table context indices and counts must be nonnegative integers"
            )
    for index, count in (("row_index", "row_count"), ("column_index", "column_count")):
        if index in context and (
            count not in context or cast(int, context[index]) >= cast(int, context[count])
        ):
            raise WorldAnalysisError("Table context position falls outside its table")
    conditions = context["conditions"]
    allowed = {
        "firstRow",
        "lastRow",
        "firstCol",
        "lastCol",
        "band1Horz",
        "band2Horz",
        "band1Vert",
        "band2Vert",
        "nwCell",
        "neCell",
        "swCell",
        "seCell",
    }
    if not isinstance(conditions, list) or any(
        not isinstance(value, str) or value not in allowed for value in conditions
    ):
        raise WorldAnalysisError("Unknown table format condition")


def template_rules(snapshot: JsonObject, source_id: str) -> list[JsonObject]:
    """Keep role selectors first class; arbitrary effective properties remain in the snapshot."""
    groups: dict[tuple[str, str], list[str]] = {}
    for item in require_objects(snapshot["objects"], "objects"):
        key = (str(item["kind"]), str(item["role"]))
        groups.setdefault(key, []).append(str(item["object_id"]))
    for style in require_objects(snapshot.get("style_definitions", []), "style definitions"):
        if style["type"] != "paragraph" or style["role"] == "unknown":
            continue
        for kind in ("paragraph", "run"):
            groups.setdefault((kind, str(style["role"])), []).append(str(style["object_id"]))
    return [
        {
            "rule_id": "rule-" + record_digest({"kind": kind, "role": role}),
            "property": "object_format",
            "label": f"{role} ({kind})",
            "expected": {"kind": kind, "role": role},
            "unit": "effective_format",
            "basis_status": "confirmed",
            "confirmation_method": "explicit_template_selection",
            "scope": {"kind": kind, "role": role},
            "template_object_ids": objects,
            "evidence": [
                {"source_id": source_id, "locator": identity, "quote": "Selected template object"}
                for identity in objects
            ],
            "limitations": [],
        }
        for (kind, role), objects in sorted(groups.items())
    ]


def template_font_requirements(
    snapshot: JsonObject, *, include_style_definitions: bool = True
) -> list[JsonObject]:
    """Expose exact fonts from text and the comparator's missing-role style profiles."""
    from research_file_workbench.journals.template_compare import (
        _is_table_related,
        _run_slot_is_used,
        _semantic_context_key,
        _semantic_index,
        _style_definition_groups,
    )

    families: dict[str, tuple[set[str], set[str]]] = {}
    objects = require_objects(snapshot["objects"], "objects")
    candidates = [
        item for item in objects if item["kind"] == "run" and str(item.get("text") or "").strip()
    ]
    if include_style_definitions:
        semantics = _semantic_index(objects)
        occupied = {
            _semantic_context_key(item, semantics)
            for item in objects
            if not _is_table_related(item)
        }
        candidates.extend(
            item
            for group in _style_definition_groups(snapshot, occupied).values()
            for item in group
            if item["kind"] == "run"
        )
    for item in candidates:
        properties = require_object(item["properties"], "properties")
        run = require_object(properties.get("run"), "effective run")
        usage = require_object(properties.get("script_usage"), "script usage")
        for lane, styles in (
            (None, run),
            ("latinLane", run.get("latinLane")),
            ("complexLane", run.get("complexLane")),
        ):
            if not isinstance(styles, dict):
                continue
            for field in ("fontFamily", "fontFamilyEastAsia"):
                if lane == "complexLane" and field == "fontFamilyEastAsia":
                    continue
                path = ("run", field) if lane is None else ("run", lane, field)
                family = styles.get(field)
                if (
                    not isinstance(family, str)
                    or not family.strip()
                    or not _run_slot_is_used(path, properties)
                ):
                    continue
                if field == "fontFamilyEastAsia":
                    scripts = {"east_asian"}
                elif lane == "complexLane":
                    scripts = {"complex"}
                else:
                    scripts = {"latin", "other"}
                    if lane is None:
                        complex_lane = run.get("complexLane")
                        if not isinstance(complex_lane, dict) or not complex_lane.get("fontFamily"):
                            scripts.add("complex")
                active = {script for script in scripts if usage.get(script) is True}
                if not active:
                    continue
                roles, used_scripts = families.setdefault(family, (set(), set()))
                roles.add(str(item["role"]))
                used_scripts.update(active)
    return [
        {"family": family, "roles": sorted(roles), "scripts": sorted(scripts)}
        for family, (roles, scripts) in sorted(families.items())
    ]


def template_coverage_gaps(snapshot: JsonObject, source_id: str) -> list[JsonObject]:
    """Summarize interpretation gaps while raw parts and object facts remain queryable."""
    groups: dict[str, tuple[int, str | None]] = {}
    for item in require_objects(snapshot["unsupported"], "unsupported"):
        code = "core_" + str(item["code"])
        count, locator = groups.get(code, (0, None))
        objects = item.get("object_ids")
        representative = str(objects[0]) if isinstance(objects, list) and objects else None
        groups[code] = (count + 1, locator or representative)
    for item in require_objects(snapshot["objects"], "objects"):
        role_code = "template_unknown_role" if item["role"] == "unknown" else None
        region = item.get("region")
        if (
            item["kind"] == "section"
            and isinstance(region, dict)
            and region.get("role") in {"unknown", "mixed"}
        ):
            role_code = "template_" + str(region["role"]) + "_region"
        if role_code:
            count, locator = groups.get(role_code, (0, None))
            groups[role_code] = (count + 1, locator or str(item["object_id"]))
    return [
        {
            "code": code,
            "source_id": source_id,
            "property": None,
            "locator": locator,
            "message": (
                f"{count} retained template observations have {code}; "
                "inspect exact parts/objects with docx-query. "
                "This is an interpretation gap, not a compliance verdict."
            ),
        }
        for code, (count, locator) in sorted(groups.items())
    ]


def validate_template_world(world: JsonObject) -> None:
    """Check identity-bearing template metadata without reinterpreting historical facts."""
    template = require_object(world.get("template"), "selected template")
    require_keys(
        template,
        {
            "source_id",
            "normalized_source_id",
            "snapshot_source_id",
            "source_sha256",
            "original_sha256",
            "provenance",
            "authority",
        },
        {"font_requirements"},
    )
    if template["authority"] != "user_designated_template":
        raise WorldAnalysisError("Template authority must record explicit template selection")
    sources = {
        str(item["source_id"]): item for item in require_objects(world["sources"], "sources")
    }
    for key, digest in (
        ("source_id", "original_sha256"),
        ("normalized_source_id", "source_sha256"),
    ):
        if (
            template[key] not in sources
            or sources[str(template[key])]["sha256"] != template[digest]
        ):
            raise WorldAnalysisError("Template metadata differs from retained sources")
    if template["snapshot_source_id"] not in sources:
        raise WorldAnalysisError("Template snapshot source is missing")
    for rule in require_objects(world["rules"], "rules"):
        if rule.get("property") != "object_format":
            from research_file_workbench.journals.models import _validate_rule

            _validate_rule(rule, str(world["journal_id"]), set(sources))
            continue
        if (
            rule.get("confirmation_method") != "explicit_template_selection"
            or rule.get("basis_status") != "confirmed"
        ):
            raise WorldAnalysisError("Selected template rules must retain selection authority")


def validate_template_sources(world: JsonObject, sources: dict[str, bytes]) -> None:
    template = require_object(world["template"], "template")
    snapshot = decode_json_object(sources[str(template["snapshot_source_id"])])
    validate_snapshot(snapshot, sources[str(template["normalized_source_id"])])
    legacy_font_requirements = world["analyzer_version"] in {
        "docx-template-analyzer-1.0.0",
        "docx-template-analyzer-1.1.0",
        "docx-template-analyzer-1.2.0",
    }
    if "font_requirements" in template and template[
        "font_requirements"
    ] != template_font_requirements(
        snapshot, include_style_definitions=not legacy_font_requirements
    ):
        raise WorldAnalysisError("Template font requirements differ from active captured run fonts")
    object_rules = [
        rule
        for rule in require_objects(world["rules"], "rules")
        if rule["property"] == "object_format"
    ]
    if object_rules != template_rules(snapshot, str(template["normalized_source_id"])):
        raise WorldAnalysisError("Template requirements differ from captured core facts")
    from research_file_workbench.journals.analysis import analyze_world
    from research_file_workbench.journals.models import SourceInput

    guide_sources = [
        SourceInput(str(item["name"]), str(item["kind"]), sources[str(item["source_id"])])
        for item in require_objects(world["sources"], "sources")
        if item["kind"] in {"guide_text", "guide_docx", "guide_pdf", "rule_component_json"}
    ]
    expected_rules: list[JsonObject] = []
    if guide_sources:
        scope = require_object(world["scope"], "scope")
        guides = analyze_world(
            str(world["journal_id"]),
            str(world["journal_name"]),
            guide_sources,
            article_type=str(scope["article_type"]),
            stage=str(scope["stage"]),
            language=str(scope["language"]),
        )
        expected_rules = require_objects(guides["rules"], "guide rules")
    if [
        rule
        for rule in require_objects(world["rules"], "rules")
        if rule["property"] != "object_format"
    ] != expected_rules:
        raise WorldAnalysisError("Guide requirements differ from captured source analysis")
    provenance = template["provenance"]
    if provenance is not None:
        record = require_object(provenance, "conversion provenance")
        require_keys(record, {"engine", "version", "method", "converted_sha256"})
        for name in ("engine", "version", "method"):
            require_text(record[name], name)
        if record["converted_sha256"] != template["source_sha256"]:
            raise WorldAnalysisError("Conversion provenance identifies different normalized bytes")
    elif template["original_sha256"] != template["source_sha256"]:
        raise WorldAnalysisError("Changed template bytes require conversion provenance")
