"""Source-bound core snapshots and explicitly selected template worlds."""

from __future__ import annotations

from io import BytesIO
from zipfile import ZipFile

from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
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

TEMPLATE_ANALYZER_VERSION = "docx-template-analyzer-1.0.0"
TEMPLATE_CHECKER_VERSION = "docx-template-checker-1.0.0"
SNAPSHOT_METHOD = "docx-core-format-snapshot-1.0.0"


def validate_snapshot(snapshot: JsonObject, content: bytes) -> None:
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
    )
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
    for item in require_objects(snapshot["objects"], "snapshot objects"):
        identity = require_text(item.get("object_id"), "object ID")
        if identity in ids or item.get("part") not in seen:
            raise WorldAnalysisError("Snapshot object identity or part is invalid")
        ids.add(identity)
        path = item.get("path")
        if not isinstance(path, list) or any(type(value) is not int or value < 0 for value in path):
            raise WorldAnalysisError("Snapshot paths must contain nonnegative child indices")
        expected_id = str(item["part"]) + "#" + ".".join(str(index) for index in path)
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
    for item in require_objects(snapshot["objects"], "snapshot objects"):
        if (
            "region" in item
            and require_object(item["region"], "region")["section_object_id"] not in ids
        ):
            raise WorldAnalysisError("Region identifies an absent section object")
    require_object(snapshot["capabilities"], "snapshot capabilities")
    require_objects(snapshot["unsupported"], "snapshot unsupported")
    encode_json_object(snapshot)


def template_rules(snapshot: JsonObject, source_id: str) -> list[JsonObject]:
    """Keep role selectors first class; arbitrary effective properties remain in the snapshot."""
    groups: dict[tuple[str, str], list[str]] = {}
    for item in require_objects(snapshot["objects"], "objects"):
        key = (str(item["kind"]), str(item["role"]))
        groups.setdefault(key, []).append(str(item["object_id"]))
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


def template_font_requirements(snapshot: JsonObject) -> list[JsonObject]:
    """Expose exact font families in active text lanes for existing font acquisition."""
    from research_file_workbench.journals.template_compare import _run_slot_is_used

    families: dict[str, tuple[set[str], set[str]]] = {}
    for item in require_objects(snapshot["objects"], "objects"):
        if item["kind"] != "run" or not str(item.get("text") or "").strip():
            continue
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
    if "font_requirements" in template and template[
        "font_requirements"
    ] != template_font_requirements(snapshot):
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
