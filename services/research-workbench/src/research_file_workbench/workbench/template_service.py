"""Template adoption, core facts and comparison on the existing domain stores."""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.docx.package_query import query_package
from research_file_workbench.journals.analysis import analyze_world
from research_file_workbench.journals.models import (
    WORLD_SCHEMA_VERSION,
    SourceInput,
    record_digest,
    require_identifier,
    require_keys,
    require_object,
    require_objects,
    require_text,
    validate_scope,
    world_version_id,
)
from research_file_workbench.journals.store_records import BindingConflictError
from research_file_workbench.journals.template_checks import compare_world
from research_file_workbench.journals.template_models import (
    SNAPSHOT_METHOD,
    TEMPLATE_ANALYZER_VERSION,
    TEMPLATE_CHECKER_VERSION,
    template_coverage_gaps,
    template_font_requirements,
    template_rules,
    validate_snapshot,
)
from research_file_workbench.projects.service import open_project
from research_file_workbench.workbench.http_boundary import captured_bytes, text

if TYPE_CHECKING:
    from research_file_workbench.workbench.service import WorkbenchService


def adopt_template(service: WorkbenchService, payload: JsonObject) -> JsonObject:
    require_keys(
        payload,
        {
            "journal_id",
            "journal_name",
            "article_type",
            "stage",
            "language",
            "original",
            "normalized",
            "snapshot",
        },
        {"sources"},
    )
    journal_id = require_identifier(payload["journal_id"], "journal ID")
    journal_name = require_text(payload["journal_name"], "journal name")
    scope = validate_scope({key: payload[key] for key in ("article_type", "stage", "language")})
    original = require_object(payload["original"], "original template")
    normalized = require_object(payload["normalized"], "normalized template")
    require_keys(original, {"filename", "content_base64"})
    require_keys(normalized, {"filename", "content_base64", "provenance"})
    raw, docx = captured_bytes(original), captured_bytes(normalized)
    snapshot = require_object(payload["snapshot"], "snapshot")
    validate_snapshot(snapshot, docx)
    snapshot_bytes = encode_json_object(snapshot).encode()
    descriptors: list[JsonObject] = []
    sources: dict[str, bytes] = {}
    for name, kind, content in (
        (text(original, "filename"), "template_original", raw),
        (text(normalized, "filename"), "template_docx", docx),
        ("core-format-snapshot.json", "docx_format_snapshot", snapshot_bytes),
    ):
        source_id = "source-" + sha256_bytes(content)
        sources[source_id] = content
        descriptors.append(
            {
                "source_id": source_id,
                "sha256": sha256_bytes(content),
                "name": name,
                "kind": kind,
                "status": "analyzed",
                "limitations": [],
            }
        )
    guide_inputs: list[SourceInput] = []
    for source in require_objects(payload.get("sources", []), "additional sources"):
        require_keys(source, {"name", "kind", "content_base64"})
        captured = SourceInput(text(source, "name"), text(source, "kind"), captured_bytes(source))
        guide_inputs.append(captured)
        sources[captured.source_id] = captured.content
        descriptor: JsonObject = {
            "source_id": captured.source_id,
            "sha256": sha256_bytes(captured.content),
            "name": captured.name,
            "kind": captured.kind,
            "status": "captured",
            "limitations": ["Retained additional guide; requirement analysis remains pending."],
        }
        if descriptor not in descriptors:
            descriptors.append(descriptor)
    guide_world = (
        analyze_world(
            journal_id,
            journal_name,
            guide_inputs,
            article_type=str(scope["article_type"]),
            stage=str(scope["stage"]),
            language=str(scope["language"]),
        )
        if guide_inputs
        else None
    )
    if guide_world is not None:
        guide_descriptors = require_objects(guide_world["sources"], "guide sources")
        descriptors = descriptors[:3] + guide_descriptors
    template: JsonObject = {
        "source_id": "source-" + sha256_bytes(raw),
        "normalized_source_id": "source-" + sha256_bytes(docx),
        "snapshot_source_id": "source-" + sha256_bytes(snapshot_bytes),
        "source_sha256": sha256_bytes(docx),
        "original_sha256": sha256_bytes(raw),
        "provenance": normalized["provenance"],
        "authority": "user_designated_template",
        "font_requirements": template_font_requirements(snapshot),
    }
    world: JsonObject = {
        "schema_version": WORLD_SCHEMA_VERSION,
        "journal_id": journal_id,
        "journal_name": journal_name,
        "scope": scope,
        "analyzer_version": TEMPLATE_ANALYZER_VERSION,
        "reader_version": SNAPSHOT_METHOD,
        "sources": descriptors,
        "rules": template_rules(snapshot, str(template["normalized_source_id"]))
        + (require_objects(guide_world["rules"], "guide rules") if guide_world else []),
        "coverage_gaps": (
            require_objects(guide_world["coverage_gaps"], "guide gaps") if guide_world else []
        )
        + template_coverage_gaps(snapshot, str(template["normalized_source_id"])),
        "limitations": [],
        "template": template,
    }
    world["version_id"] = world_version_id(world)
    return service.store.save_world(world, sources)


def retain_format(service: WorkbenchService, payload: JsonObject) -> JsonObject:
    require_keys(payload, {"project_id", "baseline_id", "snapshot"})
    project = open_project(service.project_root(text(payload, "project_id")))
    baseline_id = text(payload, "baseline_id")
    baseline = project.get_baseline(baseline_id)
    content = project.read_artifact("artifact-version-" + str(baseline["source_sha256"]))
    snapshot = require_object(payload["snapshot"], "snapshot")
    validate_snapshot(snapshot, content)
    return project.save_format_snapshot(baseline_id, snapshot)


def query_document(service: WorkbenchService, payload: JsonObject) -> JsonObject:
    target = require_object(payload.get("target"), "document target")
    operation = text(payload, "operation")
    snapshot: JsonObject | None
    if operation == "findings":
        require_keys(target, {"check_id"})
        require_keys(
            payload,
            {"target", "operation"},
            {"offset", "limit", "verdict", "role", "property_path"},
        )
        check = service.store.get_check(text(target, "check_id"))
        comparison = require_object(check.get("template_comparison"), "template comparison")
        project = open_project(service.project_root(str(check["project_id"])))
        retained = decode_json_object(
            project.read_artifact(str(comparison["findings_artifact_version_id"]))
        )
        items = require_objects(retained["findings"], "retained findings")
        for field in ("verdict", "role", "property_path"):
            if field in payload:
                value = require_text(payload[field], field)
                items = [item for item in items if item[field] == value]
        offset, limit = payload.get("offset", 0), payload.get("limit", 100)
        if (
            type(offset) is not int
            or offset < 0
            or type(limit) is not int
            or not 1 <= limit <= 1000
        ):
            raise ValueError("Findings pagination requires offset >= 0 and limit 1..1000")
        end = min(offset + limit, len(items))
        return {
            "schema_version": 1,
            "operation": "findings",
            "check_id": check["check_id"],
            "source_sha256": check["source_sha256"],
            "findings": items[offset:end],
            "total": len(items),
            "has_more": end < len(items),
            "next_offset": end if end < len(items) else None,
        }
    if "world_version_id" in target:
        require_keys(target, {"world_version_id"})
        world = service.store.get_world(text(target, "world_version_id"))
        template = require_object(world.get("template"), "template")
        content = service.store.read_source(str(template["normalized_source_id"]))
        snapshot = decode_json_object(
            service.store.read_source(str(template["snapshot_source_id"]))
        )
    else:
        require_keys(target, {"project_id", "baseline_id"})
        project = open_project(service.project_root(text(target, "project_id")))
        baseline = project.get_baseline(text(target, "baseline_id"))
        content = project.read_artifact("artifact-version-" + str(baseline["source_sha256"]))
        snapshot = (
            project.get_format_snapshot(text(target, "baseline_id"))
            if operation == "snapshot"
            else None
        )
    if operation == "snapshot":
        require_keys(payload, {"target", "operation"}, {"offset", "limit"})
        result: JsonObject = {
            "schema_version": 1,
            "source_sha256": sha256_bytes(content),
            "snapshot": snapshot,
        }
        if "offset" in payload or "limit" in payload:
            offset, limit = payload.get("offset", 0), payload.get("limit", 100)
            if (
                type(offset) is not int
                or offset < 0
                or type(limit) is not int
                or not 1 <= limit <= 1000
            ):
                raise ValueError("Snapshot pagination requires offset >= 0 and limit 1..1000")
            facts = cast(JsonObject, snapshot)
            objects = cast(list[JsonObject], facts["objects"])
            end = min(offset + limit, len(objects))
            result.update(
                snapshot={**facts, "objects": objects[offset:end]},
                total=len(objects),
                has_more=end < len(objects),
                next_offset=end if end < len(objects) else None,
            )
        return result
    return query_package(content, {key: value for key, value in payload.items() if key != "target"})


def check_template(service: WorkbenchService, payload: JsonObject) -> JsonObject:
    require_keys(
        payload,
        {
            "project_id",
            "expected_baseline_id",
            "world_version_id",
            "expected_binding_id",
            "request_id",
            "origin",
        },
    )
    project_id = text(payload, "project_id")
    baseline_id, world_id = text(payload, "expected_baseline_id"), text(payload, "world_version_id")
    request_id = text(payload, "request_id")
    origin = require_object(payload["origin"], "check origin")
    require_keys(origin, {"surface"}, {"reason"})
    if origin["surface"] not in {"user", "agent"}:
        raise ValueError("Template comparison origin must be user or agent")
    if "reason" in origin:
        require_text(origin["reason"], "reason")
    expected_binding = payload["expected_binding_id"]
    if expected_binding is not None:
        require_text(expected_binding, "expected binding")
    identity = "check-" + record_digest({"project_id": project_id, "request_id": request_id})
    request_digest = record_digest(payload)
    for saved in service.store.list_checks(project_id):
        if saved["check_id"] == identity:
            if saved.get("request_digest") != request_digest:
                raise BindingConflictError(
                    "Template check request ID was reused with different inputs"
                )
            return service.check_record(identity)
    world = service.store.get_world(world_id)
    template = require_object(world.get("template"), "selected template")
    template_snapshot = decode_json_object(
        service.store.read_source(str(template["snapshot_source_id"]))
    )
    project = open_project(service.project_root(project_id))
    snapshot = project.get_format_snapshot(baseline_id)
    source_bytes = project.read_artifact("artifact-version-" + str(snapshot["source_sha256"]))
    checked = compare_world(world, template_snapshot, snapshot, source_bytes)
    comparison = require_object(checked["template_comparison"], "template comparison")
    findings = require_objects(comparison["findings"], "findings")
    artifact = project.save_template_findings(baseline_id, findings)
    comparison.update(
        findings=findings[:100],
        total=len(findings),
        has_more=len(findings) > 100,
        next_offset=100 if len(findings) > 100 else None,
        findings_artifact_version_id=artifact,
    )
    with project.guard_baseline(baseline_id):
        binding = service.store.bind_project(
            project_id,
            service.project_root(project_id).as_posix(),
            baseline_id,
            world_id,
            expected_binding_id=cast(str | None, expected_binding),
            actor_id="local-operator" if origin["surface"] == "user" else "application-agent",
            surface=str(origin["surface"]),
        )
        record: JsonObject = {
            **checked,
            "check_id": identity,
            "project_id": project_id,
            "baseline_id": baseline_id,
            "binding_id": binding["binding_id"],
            "created_at": utc_now_iso(),
            "reader_version": SNAPSHOT_METHOD,
            "actor_id": "local-operator" if origin["surface"] == "user" else "application-agent",
            "surface": origin["surface"],
            "origin": origin,
            "request_id": request_id,
            "request_digest": request_digest,
            "dependencies": {
                "artifact_version_id": "artifact-version-" + str(snapshot["source_sha256"]),
                "source_sha256": snapshot["source_sha256"],
                "world_version_id": world_id,
                "reader_version": SNAPSHOT_METHOD,
                "checker_version": TEMPLATE_CHECKER_VERSION,
                "completeness": "core_object_format_comparison",
            },
        }
        service.store.save_check(record)
    return service.check_record(identity)
