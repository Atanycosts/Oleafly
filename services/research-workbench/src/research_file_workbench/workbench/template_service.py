"""Template adoption, core facts and comparison on the existing domain stores."""

from __future__ import annotations

from base64 import b64encode
from typing import TYPE_CHECKING, cast

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.hashing import sha256_bytes
from research_file_workbench.common.json_io import (
    JsonObject,
    decode_json_object,
    encode_json_object,
)
from research_file_workbench.docx.format_snapshot import (
    RECAPTUREABLE_SNAPSHOT_METHODS,
    format_snapshot_method,
)
from research_file_workbench.docx.normalization import DocxNormalizationError, normalize_docx
from research_file_workbench.docx.package_query import query_package
from research_file_workbench.journals.analysis import analyze_world
from research_file_workbench.journals.models import (
    WORLD_SCHEMA_VERSION,
    SourceInput,
    WorldAnalysisError,
    record_digest,
    require_identifier,
    require_keys,
    require_object,
    require_objects,
    require_text,
    validate_scope,
    validate_world_for_execution,
    world_version_id,
)
from research_file_workbench.journals.revisions import apply_manual_decisions
from research_file_workbench.journals.store_records import (
    BindingConflictError,
    WorldStoreError,
)
from research_file_workbench.journals.template_checks import compare_world
from research_file_workbench.journals.template_models import (
    SNAPSHOT_METHOD,
    TEMPLATE_ANALYZER_VERSION,
    TEMPLATE_CHECKER_VERSION,
    template_coverage_gaps,
    template_font_requirements,
    template_preparation,
    template_reference_locations,
    template_rules,
    validate_snapshot,
    validate_template_analysis,
    validate_template_snapshot_source,
    validate_template_world,
)
from research_file_workbench.projects.format_records import FormatSnapshotReference
from research_file_workbench.projects.models import BaselineConflictError
from research_file_workbench.projects.service import open_project
from research_file_workbench.workbench.bound_template_styles import (
    build_template_styles_result,
    parse_template_styles_query,
)
from research_file_workbench.workbench.finding_queries import (
    FindingQueryView,
    build_finding_query_view,
    candidate_findings_result,
    filter_finding_records,
    finding_groups_result,
    finding_locations_result,
    finding_verification_result,
    remaining_review_groups,
    validate_pagination,
    validate_verification_targets,
    with_line_spacing_rules,
)
from research_file_workbench.workbench.http_boundary import captured_bytes, optional_text, text

if TYPE_CHECKING:
    from research_file_workbench.workbench.service import WorkbenchService


_LEGACY_WORD_SIGNATURE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


class TemplatePreparationError(ValueError):
    """An actionable refusal to prepare an exact retained template for a candidate."""

    def __init__(
        self, code: str, message: str, *, action: str, world_version_id: str | None = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.action = action
        self.world_version_id = world_version_id


def prepare_template(service: WorkbenchService, payload: JsonObject) -> JsonObject:
    """Return an execution-ready selected template before an isolated candidate is created."""
    require_keys(
        payload,
        {"project_id", "expected_baseline_id"},
        {"world_version_id", "surface", "include_snapshot_reference", "retained_snapshot"},
    )
    project_id = text(payload, "project_id")
    baseline_id = text(payload, "expected_baseline_id")
    surface_value = payload.get("surface", "user")
    if not isinstance(surface_value, str) or surface_value not in {"user", "agent"}:
        raise ValueError("Template preparation surface must be user or agent")
    surface = surface_value
    include_snapshot_reference = payload.get("include_snapshot_reference", False)
    if not isinstance(include_snapshot_reference, bool):
        raise ValueError("include_snapshot_reference must be a boolean")
    project = open_project(service.project_root(project_id))
    if project.info()["current_baseline_id"] != baseline_id:
        raise TemplatePreparationError(
            "template_baseline_changed",
            "The manuscript changed before template preparation. Reload the current manuscript "
            "baseline and choose the template again.",
            action="reload_manuscript",
        )

    binding = service.store.get_binding(project_id)
    selected_id = (
        text(payload, "world_version_id")
        if "world_version_id" in payload
        else require_text(binding["world_version_id"], "binding world version")
        if binding is not None
        else None
    )
    if selected_id is None:
        raise TemplatePreparationError(
            "template_selection_required",
            "Choose a retained DOCX formatting template before creating a candidate.",
            action="select_template",
        )
    world = _prepared_world(service, selected_id, payload.get("retained_snapshot"))
    refreshed = world["version_id"] != selected_id

    if (
        refreshed
        and not include_snapshot_reference
        and binding is not None
        and selected_id == binding["world_version_id"]
    ):
        name = _template_name(world)
        try:
            with project.guard_baseline(baseline_id):
                binding = service.store.bind_project(
                    project_id,
                    service.project_root(project_id).as_posix(),
                    baseline_id,
                    str(world["version_id"]),
                    expected_binding_id=str(binding["binding_id"]),
                    actor_id="local-operator" if surface == "user" else "application-agent",
                    surface=surface,
                )
        except BindingConflictError as exc:
            raise BindingConflictError(
                f'Template "{name}" could not be applied for the {surface} request because '
                "the project binding changed. Reload the project and select the template again."
            ) from exc
        except BaselineConflictError as exc:
            raise BaselineConflictError(
                f'Template "{name}" could not be applied for the {surface} request because '
                "the manuscript baseline changed. Reload the current baseline and try again.",
                result=exc.result,
            ) from exc
    else:
        binding = service.store.get_binding(project_id)
    result: JsonObject = {"world": world, "binding": binding, "refreshed": refreshed}
    if include_snapshot_reference:
        result["snapshot_reference"] = project.find_format_snapshot_reference(
            baseline_id, method_version=SNAPSHOT_METHOD
        )
    return result


def _prepared_world(
    service: WorkbenchService, version_id: str, retained_snapshot: object
) -> JsonObject:
    try:
        world = service.store.get_world_metadata(version_id)
    except WorldStoreError as exc:
        raise TemplatePreparationError(
            "template_world_unavailable",
            "The selected template version is no longer available. Choose a retained template.",
            action="select_template",
        ) from exc
    if "template" not in world:
        name = _template_name(world)
        raise TemplatePreparationError(
            "template_world_invalid",
            f'"{name}" is not a DOCX formatting template. Choose a retained template.',
            action="select_template",
        )
    name = _template_name(world)
    try:
        validate_template_world(world)
    except WorldAnalysisError as exc:
        raise TemplatePreparationError(
            "template_world_invalid",
            f'Template "{name}" cannot be verified from its retained record. Recapture it.',
            action="recapture_template",
        ) from exc

    preparation = template_preparation(world)
    if preparation["state"] == "unsupported":
        if preparation["reason"] == "snapshot_method_outdated":
            raise TemplatePreparationError(
                "template_snapshot_outdated",
                f'Template "{name}" was analyzed with an older DOCX format snapshot. '
                "Recapture that exact template before creating a candidate.",
                action="recapture_template",
            )
        raise TemplatePreparationError(
            "template_refresh_unsupported",
            f'Template "{name}" cannot be refreshed by this Workbench version. '
            "Choose another retained template or recapture it.",
            action="recapture_template",
        )

    if preparation["state"] == "pending_refresh":
        refreshed = service.store.get_template_refresh(
            version_id, TEMPLATE_ANALYZER_VERSION, SNAPSHOT_METHOD
        )
        if refreshed is not None:
            world = refreshed
            preparation = template_preparation(world)
            retained_snapshot = None

    sources = _read_template_sources(service, world, name)
    snapshot = _validated_template_snapshot(
        service, world, sources, name, require_current=preparation["state"] != "pending_refresh"
    )
    if format_snapshot_method(snapshot) in RECAPTUREABLE_SNAPSHOT_METHODS:
        if retained_snapshot is None:
            raise TemplatePreparationError(
                "template_snapshot_recapture_required",
                f'Template "{name}" needs updated format facts from its retained DOCX.',
                action="capture_retained_docx",
                world_version_id=version_id,
            )
        capture = require_object(retained_snapshot, "retained template capture")
        require_keys(capture, {"world_version_id", "snapshot"})
        if capture["world_version_id"] != version_id:
            raise TemplatePreparationError(
                "template_selection_changed",
                "The selected template changed during refresh. Select it again.",
                action="select_template",
            )
        template = require_object(world["template"], "selected template")
        current_snapshot = require_object(capture["snapshot"], "current template snapshot")
        try:
            validate_snapshot(
                current_snapshot,
                sources[str(template["normalized_source_id"])],
                require_current=True,
            )
        except ValueError as exc:
            raise TemplatePreparationError(
                "template_snapshot_recapture_invalid",
                f'The new format facts for "{name}" do not match its retained DOCX. '
                "Recapture the template.",
                action="recapture_template",
            ) from exc
        return _save_refreshed_world(
            service,
            world,
            sources,
            current_snapshot,
            snapshot_bytes=encode_json_object(current_snapshot).encode(),
        )
    if retained_snapshot is not None:
        raise TemplatePreparationError(
            "template_selection_changed",
            "The selected template changed during refresh. Select it again.",
            action="select_template",
        )
    if preparation["state"] == "pending_refresh":
        return _save_refreshed_world(service, world, sources, snapshot)
    try:
        validate_world_for_execution(world)
        validate_template_analysis(world, sources, snapshot)
    except WorldAnalysisError as exc:
        raise TemplatePreparationError(
            "template_world_invalid",
            f'Template "{name}" has retained facts that do not match its source bytes. '
            "Recapture it before creating a candidate.",
            action="recapture_template",
        ) from exc
    return world


def _template_name(world: JsonObject) -> str:
    return require_text(world.get("journal_name"), "template name")


def _read_template_sources(
    service: WorkbenchService, world: JsonObject, name: str
) -> dict[str, bytes]:
    sources: dict[str, bytes] = {}
    try:
        for source in require_objects(world["sources"], "world sources"):
            source_id = str(source["source_id"])
            content = service.store.read_source(source_id)
            if sha256_bytes(content) != source["sha256"]:
                raise WorldStoreError("Retained template source differs from its declared hash")
            sources[source_id] = content
    except WorldStoreError as exc:
        raise TemplatePreparationError(
            "template_source_unavailable",
            f'Template "{name}" has retained source bytes that are missing or corrupt. '
            "Recapture the original template before creating a candidate.",
            action="recapture_template",
        ) from exc
    return sources


def _validated_template_snapshot(
    service: WorkbenchService,
    world: JsonObject,
    sources: dict[str, bytes],
    name: str,
    *,
    require_current: bool = True,
) -> JsonObject:
    template = require_object(world["template"], "selected template")
    normalized_id = str(template["normalized_source_id"])
    snapshot_id = str(template["snapshot_source_id"])
    original_id = str(template["source_id"])
    normalized = sources.get(normalized_id)
    snapshot_bytes = sources.get(snapshot_id)
    original = sources.get(original_id)
    if normalized is None or snapshot_bytes is None or original is None:
        raise TemplatePreparationError(
            "template_source_unavailable",
            f'Template "{name}" is missing its original, normalized or format snapshot source. '
            "Recapture the original template before creating a candidate.",
            action="recapture_template",
        )
    if (
        sha256_bytes(normalized) != template["source_sha256"]
        or sha256_bytes(original) != template["original_sha256"]
    ):
        raise TemplatePreparationError(
            "template_source_unavailable",
            f'Template "{name}" has retained source bytes that differ from its recorded identity. '
            "Recapture the original template before creating a candidate.",
            action="recapture_template",
        )
    try:
        snapshot = decode_json_object(snapshot_bytes)
        if require_current and format_snapshot_method(snapshot) != SNAPSHOT_METHOD:
            raise TemplatePreparationError(
                "template_snapshot_outdated",
                f'Template "{name}" was analyzed with an older DOCX format snapshot. '
                "Recapture that exact template before creating a candidate.",
                action="recapture_template",
            )
        validate_template_snapshot_source(world, sources, snapshot)
    except TemplatePreparationError:
        raise
    except ValueError as exc:
        raise TemplatePreparationError(
            "template_source_unavailable",
            f'Template "{name}" has retained DOCX and format snapshot facts that do not agree. '
            "Recapture the original template before creating a candidate.",
            action="recapture_template",
        ) from exc
    _remember_template_snapshot(service, world, sources, snapshot)
    return snapshot


def _retained_template_snapshot(service: WorkbenchService, world: JsonObject) -> JsonObject:
    """Return a parsed snapshot from a verified world while always rechecking source bytes."""
    version_id = require_text(world.get("version_id"), "world version")
    template = require_object(world.get("template"), "selected template")
    snapshot_source_id = require_text(template.get("snapshot_source_id"), "snapshot source")
    normalized_source_id = require_text(template.get("normalized_source_id"), "normalized source")
    method = require_text(world.get("reader_version"), "template snapshot method")
    normalized = service.store.read_source(normalized_source_id)
    snapshot_bytes = service.store.read_source(snapshot_source_id)
    snapshot_sha256 = sha256_bytes(snapshot_bytes)
    cached = service.cached_template_snapshot(
        version_id, snapshot_source_id, snapshot_sha256, method
    )
    if cached is not None:
        return cached
    snapshot = decode_json_object(snapshot_bytes)
    if format_snapshot_method(snapshot) != method:
        raise WorldAnalysisError("Template snapshot method differs from its world record")
    validate_template_snapshot_source(
        world,
        {normalized_source_id: normalized, snapshot_source_id: snapshot_bytes},
        snapshot,
    )
    service.cache_template_snapshot(
        version_id, snapshot_source_id, snapshot_sha256, method, snapshot
    )
    return snapshot


def _remember_template_snapshot(
    service: WorkbenchService,
    world: JsonObject,
    sources: dict[str, bytes],
    snapshot: JsonObject,
) -> None:
    template = require_object(world.get("template"), "selected template")
    snapshot_source_id = require_text(template.get("snapshot_source_id"), "snapshot source")
    service.cache_template_snapshot(
        require_text(world.get("version_id"), "world version"),
        snapshot_source_id,
        sha256_bytes(sources[snapshot_source_id]),
        format_snapshot_method(snapshot),
        snapshot,
    )


def _save_refreshed_world(
    service: WorkbenchService,
    world: JsonObject,
    sources: dict[str, bytes],
    snapshot: JsonObject,
    *,
    snapshot_bytes: bytes | None = None,
) -> JsonObject:
    template = require_object(world["template"], "selected template")
    scope = require_object(world["scope"], "template scope")
    name = _template_name(world)
    source_records = require_objects(world["sources"], "world sources")

    def descriptor(source_id: str, kind: str) -> JsonObject:
        matches = [
            source
            for source in source_records
            if source["source_id"] == source_id and source["kind"] == kind
        ]
        if len(matches) != 1:
            raise TemplatePreparationError(
                "template_world_invalid",
                f'Template "{name}" has an ambiguous original, normalized or snapshot source role. '
                "Recapture that template.",
                action="recapture_template",
            )
        return matches[0]

    guide_inputs = [
        SourceInput(
            str(source["name"]),
            str(source["kind"]),
            content,
        )
        for source_id, content in sources.items()
        for source in source_records
        if source["source_id"] == source_id
        and source["kind"] in {"guide_text", "guide_docx", "guide_pdf", "rule_component_json"}
    ]
    try:
        guide_world = (
            analyze_world(
                str(world["journal_id"]),
                str(world["journal_name"]),
                guide_inputs,
                article_type=str(scope["article_type"]),
                stage=str(scope["stage"]),
                language=str(scope["language"]),
            )
            if guide_inputs
            else None
        )
    except WorldAnalysisError as exc:
        raise TemplatePreparationError(
            "template_refresh_unsupported",
            f'Template "{name}" has retained requirement sources that cannot be reanalyzed. '
            "Recapture the template and its requirement sources.",
            action="recapture_template",
        ) from exc

    original_id = str(template["source_id"])
    normalized_id = str(template["normalized_source_id"])
    old_snapshot_id = str(template["snapshot_source_id"])
    snapshot_id = old_snapshot_id
    source_descriptors: list[JsonObject] = []
    for source_id, kind in (
        (original_id, "template_original"),
        (normalized_id, "template_docx"),
    ):
        source = descriptor(source_id, kind)
        source_descriptors.append(
            {
                "source_id": source_id,
                "sha256": source["sha256"],
                "name": source["name"],
                "kind": kind,
                "status": "analyzed",
                "limitations": [],
            }
        )
    if snapshot_bytes is None:
        snapshot_source = descriptor(snapshot_id, "docx_format_snapshot")
        snapshot_source_bytes = sources[snapshot_id]
    else:
        snapshot_id = "source-" + sha256_bytes(snapshot_bytes)
        snapshot_source = {
            "source_id": snapshot_id,
            "sha256": sha256_bytes(snapshot_bytes),
            "name": "core-format-snapshot.json",
            "kind": "docx_format_snapshot",
        }
        snapshot_source_bytes = snapshot_bytes
    source_descriptors.append(
        {
            "source_id": snapshot_id,
            "sha256": snapshot_source["sha256"],
            "name": snapshot_source["name"],
            "kind": "docx_format_snapshot",
            "status": "analyzed",
            "limitations": [],
        }
    )
    refreshed_template: JsonObject = {
        "source_id": original_id,
        "normalized_source_id": normalized_id,
        "snapshot_source_id": snapshot_id,
        "source_sha256": template["source_sha256"],
        "original_sha256": template["original_sha256"],
        "provenance": template["provenance"],
        "authority": "user_designated_template",
        "font_requirements": template_font_requirements(snapshot),
    }
    refreshed: JsonObject = {
        "schema_version": WORLD_SCHEMA_VERSION,
        "journal_id": world["journal_id"],
        "journal_name": world["journal_name"],
        "scope": scope,
        "analyzer_version": TEMPLATE_ANALYZER_VERSION,
        "reader_version": SNAPSHOT_METHOD,
        "sources": source_descriptors
        + (
            require_objects(guide_world["sources"], "guide sources")
            if guide_world is not None
            else []
        ),
        "rules": template_rules(snapshot, normalized_id)
        + (require_objects(guide_world["rules"], "guide rules") if guide_world is not None else []),
        "coverage_gaps": (
            require_objects(guide_world["coverage_gaps"], "guide gaps")
            if guide_world is not None
            else []
        )
        + template_coverage_gaps(snapshot, normalized_id),
        "limitations": [],
        "template": refreshed_template,
    }
    if "manual_decisions" in world:
        decisions = require_objects(world["manual_decisions"], "manual decisions")
        refreshed["manual_decisions"] = decisions
        try:
            apply_manual_decisions(
                require_objects(refreshed["rules"], "refreshed template rules"),
                decisions,
            )
        except WorldAnalysisError as exc:
            raise TemplatePreparationError(
                "template_refresh_unsupported",
                f'Template "{name}" has a manual requirement that no longer selects a current '
                "rule. Recapture the template and its requirement sources.",
                action="recapture_template",
            ) from exc
    refreshed["version_id"] = world_version_id(refreshed)
    validate_world_for_execution(refreshed)
    world_sources = {
        original_id: sources[original_id],
        normalized_id: sources[normalized_id],
        snapshot_id: snapshot_source_bytes,
    }
    for guide_source in require_objects((guide_world or {}).get("sources", []), "guide sources"):
        source_id = str(guide_source["source_id"])
        world_sources[source_id] = sources[source_id]
    saved = service.store.save_world(refreshed, world_sources, refresh_of=str(world["version_id"]))
    if saved["version_id"] == refreshed["version_id"]:
        _remember_template_snapshot(service, saved, world_sources, snapshot)
    return saved


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
    provenance = _adopted_template_provenance(raw, docx, normalized["provenance"])
    snapshot = require_object(payload["snapshot"], "snapshot")
    validate_snapshot(snapshot, docx, require_current=True)
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
        "provenance": provenance,
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


def _adopted_template_provenance(
    original: bytes, normalized: bytes, value: object
) -> JsonObject | None:
    """Bind conversion metadata to the newly uploaded source and derivative bytes."""
    if not original.startswith(_LEGACY_WORD_SIGNATURE):
        expected = normalize_docx(original)
        if normalized != expected.content or value != expected.provenance:
            raise DocxNormalizationError(
                "The template working copy or provenance differs from its original DOCX.",
                code="docx_normalization_mismatch",
            )
        return expected.provenance
    record = require_object(value, "conversion provenance")
    require_keys(record, {"engine", "version", "method", "converted_sha256"})
    for name in ("engine", "version", "method"):
        require_text(record[name], name)
    if record["converted_sha256"] != sha256_bytes(normalized):
        raise ValueError("Conversion provenance identifies different normalized template bytes")
    return record


def _snapshot_reference(value: object) -> FormatSnapshotReference:
    reference = require_object(value, "format snapshot reference")
    require_keys(
        reference,
        {"baseline_id", "source_sha256", "snapshot_artifact_version_id", "method_version"},
    )
    method = text(reference, "method_version")
    if method != SNAPSHOT_METHOD:
        raise ValueError("DOCX format reader changed; recapture manuscript format facts")
    return {
        "baseline_id": text(reference, "baseline_id"),
        "source_sha256": text(reference, "source_sha256"),
        "snapshot_artifact_version_id": text(reference, "snapshot_artifact_version_id"),
        "method_version": method,
    }


def retain_format(service: WorkbenchService, payload: JsonObject) -> JsonObject:
    require_keys(payload, {"project_id", "baseline_id"}, {"snapshot", "retained_snapshot"})
    if ("snapshot" in payload) == ("retained_snapshot" in payload):
        raise ValueError("Provide exactly one new snapshot or retained snapshot reference")
    project = open_project(service.project_root(text(payload, "project_id")))
    baseline_id = text(payload, "baseline_id")
    if "retained_snapshot" in payload:
        retained = require_object(payload["retained_snapshot"], "retained snapshot")
        require_keys(retained, {"project_id", "reference"})
        reference = _snapshot_reference(retained["reference"])
        origin = open_project(service.project_root(text(retained, "project_id")))
        artifact = origin.read_format_snapshot_artifact(reference)
        return dict(project.copy_format_snapshot(baseline_id, reference, artifact))
    baseline = project.get_baseline(baseline_id)
    content = project.read_artifact("artifact-version-" + str(baseline["source_sha256"]))
    snapshot = require_object(payload["snapshot"], "snapshot")
    validate_snapshot(snapshot, content, require_current=True)
    return project.save_format_snapshot(baseline_id, snapshot)


def template_source(service: WorkbenchService, version_id: str) -> JsonObject:
    """Read exact normalized bytes from one explicitly selected retained template."""
    world = service.store.get_world_metadata(version_id)
    template = require_object(world.get("template"), "selected Word template")
    content = service.store.read_source(str(template["normalized_source_id"]))
    if sha256_bytes(content) != template["source_sha256"]:
        raise ValueError("The retained template source does not match its world version.")
    return {
        "world_version_id": version_id,
        "source_sha256": template["source_sha256"],
        "content_base64": b64encode(content).decode("ascii"),
    }


def start_template_copy(service: WorkbenchService, payload: JsonObject) -> JsonObject:
    """Create a managed editable draft from exact retained template bytes."""
    require_keys(payload, {"world_version_id", "name", "request_id"})
    version_id = text(payload, "world_version_id")
    name = text(payload, "name")
    request_id = require_identifier(payload["request_id"], "template copy request ID")
    world = service.store.get_world(version_id)
    validate_world_for_execution(world)
    template = require_object(world.get("template"), "selected Word template")
    content = service.store.read_source(str(template["normalized_source_id"]))
    snapshot = decode_json_object(service.store.read_source(str(template["snapshot_source_id"])))
    validate_snapshot(snapshot, content, require_current=True)
    identity = "project-" + sha256_bytes(("template-copy:" + request_id).encode())[:32]
    root = service.project_root(identity)
    reason = encode_json_object(
        {
            "operation": "start_template_copy",
            "request_id": request_id,
            "world_version_id": version_id,
            "template_source_sha256": sha256_bytes(content),
            "name": name,
        }
    )
    if root.exists():
        project = open_project(root)
        initial = project.get_request("local-operator", "initial-world-workbench-import")
        initial_result = require_object(initial["result"], "initial template copy result")
        baseline = project.get_baseline(str(initial_result["result_baseline_id"]))
        if baseline["confirmation_reason"] != reason:
            raise BindingConflictError(
                "The template-copy request ID was already used for different inputs."
            )
    else:
        created = service.import_manuscript(
            name,
            "template-working-copy.docx",
            content,
            project_id=identity,
            reason=reason,
        )
        project = open_project(root)
        baseline = project.get_baseline(str(created["baseline_id"]))
    baseline_id = str(baseline["baseline_id"])
    project.save_format_snapshot(baseline_id, snapshot)
    # A retry recovers creation; it must not undo a later edit or explicit rebind.
    if service.store.get_binding(identity) is None:
        service.store.bind_project(
            identity,
            root.as_posix(),
            baseline_id,
            version_id,
            expected_binding_id=None,
            actor_id="local-operator",
            surface="browser",
        )
    return {
        "project": service.project(identity),
        "origin": {
            "request_id": request_id,
            "world_version_id": version_id,
            "baseline_id": baseline_id,
            "source_sha256": baseline["source_sha256"],
        },
    }


def query_document(service: WorkbenchService, payload: JsonObject) -> JsonObject:
    target = require_object(payload.get("target"), "document target")
    operation = text(payload, "operation")
    snapshot: JsonObject | None
    if operation in {
        "findings",
        "finding_groups",
        "finding_locations",
        "candidate_findings",
        "finding_verification",
    }:
        require_keys(target, {"check_id"})
        check = service.store.get_check(text(target, "check_id"))
        findings = _retained_check_findings(service, check)
        if operation == "finding_groups":
            require_keys(payload, {"target", "operation"})
            return finding_groups_result(
                _finding_query_view(service, check, findings),
                findings,
            )
        if operation == "finding_locations":
            require_keys(
                payload,
                {"target", "operation", "group_id"},
                {"verdict", "offset", "limit"},
            )
            offset, limit = validate_pagination(payload)
            return finding_locations_result(
                _finding_query_view(service, check, findings),
                group_id=require_text(payload["group_id"], "finding group"),
                verdict=optional_text(payload, "verdict"),
                offset=offset,
                limit=limit,
            )
        if operation == "candidate_findings":
            require_keys(
                payload,
                {"target", "operation", "property_paths"},
                {"offset", "limit"},
            )
            property_paths = payload["property_paths"]
            if not isinstance(property_paths, list):
                raise ValueError("Candidate findings property_paths must be a string list")
            offset, limit = validate_pagination(payload)
            page = candidate_findings_result(
                check,
                findings,
                property_paths=[
                    require_text(property_path, "candidate property path")
                    for property_path in property_paths
                ],
                offset=offset,
                limit=limit,
            )
            template_ids = {
                require_text(object_id, "template object ID")
                for finding in require_objects(page["findings"], "candidate findings")
                for object_id in cast(list[object], finding["template_object_ids"])[:2]
            }
            if template_ids:
                world = service.store.get_world_metadata(str(check["world_version_id"]))
                page["template_locations"] = template_reference_locations(
                    _retained_template_snapshot(service, world), template_ids
                )
            else:
                page["template_locations"] = {}
            return page
        if operation == "finding_verification":
            require_keys(payload, {"target", "operation", "targets"})
            return finding_verification_result(
                check,
                findings,
                validate_verification_targets(payload["targets"]),
            )

        require_keys(
            payload,
            {"target", "operation"},
            {
                "offset",
                "limit",
                "verdict",
                "role",
                "property_path",
                "group_id",
                "location_id",
            },
        )
        items = findings
        for field in ("verdict", "role", "property_path"):
            if field in payload:
                value = require_text(payload[field], field)
                items = [item for item in items if item[field] == value]
        group_id = optional_text(payload, "group_id")
        location_id = optional_text(payload, "location_id")
        if group_id is not None or location_id is not None:
            items = filter_finding_records(
                items,
                _finding_query_view(service, check, findings),
                group_id=group_id,
                location_id=location_id,
            )
        offset, limit = validate_pagination(payload)
        end = min(offset + limit, len(items))
        detail_findings = items[offset:end]
        if group_id is not None or location_id is not None:
            detail_findings = with_line_spacing_rules(detail_findings, findings)
        return {
            "schema_version": 1,
            "operation": "findings",
            "check_id": check["check_id"],
            "source_sha256": check["source_sha256"],
            "findings": detail_findings,
            "total": len(items),
            "has_more": end < len(items),
            "next_offset": end if end < len(items) else None,
        }
    if operation == "template_styles":
        return _bound_template_styles(service, payload, target)
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
        require_keys(payload, {"target", "operation"}, {"offset", "limit", "collection"})
        collection = payload.get("collection", "objects")
        if not isinstance(collection, str) or collection not in {"objects", "style_definitions"}:
            raise ValueError("Snapshot collection must be objects or style_definitions")
        result: JsonObject = {
            "schema_version": 1,
            "source_sha256": sha256_bytes(content),
            "snapshot": snapshot,
        }
        if "offset" in payload or "limit" in payload or "collection" in payload:
            snapshot_offset, snapshot_limit = payload.get("offset", 0), payload.get("limit", 100)
            if (
                type(snapshot_offset) is not int
                or snapshot_offset < 0
                or type(snapshot_limit) is not int
                or not 1 <= snapshot_limit <= 1000
            ):
                raise ValueError("Snapshot pagination requires offset >= 0 and limit 1..1000")
            facts = cast(JsonObject, snapshot)
            items = require_objects(facts.get(str(collection), []), str(collection))
            end = min(snapshot_offset + snapshot_limit, len(items))
            page = {
                key: value
                for key, value in facts.items()
                if key not in {"objects", "style_definitions"}
            }
            page[str(collection)] = items[snapshot_offset:end]
            result.update(
                snapshot=page,
                collection=collection,
                total=len(items),
                has_more=end < len(items),
                next_offset=end if end < len(items) else None,
            )
        return result
    return query_package(content, {key: value for key, value in payload.items() if key != "target"})


def _bound_template_styles(
    service: WorkbenchService, payload: JsonObject, target: JsonObject
) -> JsonObject:
    """Read styles from the project's current binding without selecting another world."""
    query = parse_template_styles_query(payload, target)
    if not service.project_root(query.project_id).is_dir():
        raise ValueError("The bound manuscript is not in the connected Workbench library.")
    binding = service.store.get_binding(query.project_id)
    binding_id = binding.get("binding_id") if binding is not None else None
    if query.expected_binding_id is not None and binding_id != query.expected_binding_id:
        raise BindingConflictError(
            "The project template binding changed. Restart the template style query."
        )
    if binding is None:
        return build_template_styles_result(query, "unbound", None, None)
    world = service.store.get_world_metadata(
        require_text(binding.get("world_version_id"), "binding world version")
    )
    if "template" not in world:
        return build_template_styles_result(query, "template_unavailable", binding, None)
    snapshot = _retained_template_snapshot(service, world)
    return build_template_styles_result(query, "available", binding, snapshot)


def _retained_check_findings(service: WorkbenchService, check: JsonObject) -> list[JsonObject]:
    comparison = require_object(check.get("template_comparison"), "template comparison")
    artifact = require_text(
        comparison.get("findings_artifact_version_id"), "retained findings artifact"
    )
    return service.retained_template_findings(str(check["project_id"]), artifact)


def remaining_template_review_groups(
    service: WorkbenchService, check: JsonObject, verified_snapshot: JsonObject
) -> list[JsonObject]:
    """Project pending groups without rechecking the document or reading a second snapshot."""
    findings = _retained_check_findings(service, check)
    view = _finding_query_view(service, check, findings, snapshot=verified_snapshot)
    return remaining_review_groups(view, findings)


def _finding_query_view(
    service: WorkbenchService,
    check: JsonObject,
    findings: list[JsonObject],
    *,
    snapshot: JsonObject | None = None,
) -> FindingQueryView:
    check_id = require_text(check.get("check_id"), "check ID")
    cached = service.cached_finding_query_view(check_id)
    if cached is not None:
        return cached
    baseline_id = require_text(check.get("baseline_id"), "baseline ID")
    source_sha256 = require_text(check.get("source_sha256"), "check source SHA-256")
    reader_version = require_text(check.get("reader_version"), "check reader version")
    if snapshot is None:
        snapshot = service.cached_check_snapshot(check_id)
    if snapshot is None:
        project = open_project(service.project_root(str(check["project_id"])))
        dependencies = require_object(check["dependencies"], "check dependencies")
        artifact = dependencies.get("snapshot_artifact_version_id")
        if artifact is None:
            snapshot = project.get_format_snapshot(baseline_id, method_version=reader_version)
        else:
            snapshot = project.get_format_snapshot(
                baseline_id,
                reference={
                    "baseline_id": baseline_id,
                    "source_sha256": source_sha256,
                    "snapshot_artifact_version_id": require_text(artifact, "snapshot artifact"),
                    "method_version": reader_version,
                },
            )
    if (
        snapshot["source_sha256"] != source_sha256
        or format_snapshot_method(snapshot) != reader_version
    ):
        raise ValueError("Retained format snapshot does not match the checked source and reader")
    view = build_finding_query_view(check, snapshot, findings)
    service.cache_finding_query_view(check_id, view)
    return view


def _summary_check_response(record: JsonObject, view: FindingQueryView) -> JsonObject:
    comparison = require_object(record["template_comparison"], "template comparison")
    return {
        **{
            key: record[key]
            for key in (
                "check_id",
                "project_id",
                "baseline_id",
                "world_version_id",
                "binding_id",
                "source_sha256",
                "validity",
            )
        },
        "template_comparison": {
            "source_sha256": comparison["source_sha256"],
            "total": comparison["total"],
            "finding_summary": comparison["finding_summary"],
            "findings_artifact_version_id": comparison["findings_artifact_version_id"],
            "groups": list(view.groups),
        },
    }


def _candidate_check_response(
    record: JsonObject, table_header_templates: list[JsonObject]
) -> JsonObject:
    comparison = require_object(record["template_comparison"], "template comparison")
    dependencies = require_object(record["dependencies"], "check dependencies")
    return {
        **{
            key: record[key]
            for key in (
                "check_id",
                "project_id",
                "baseline_id",
                "binding_id",
                "world_version_id",
                "source_sha256",
                "reader_version",
                "validity",
            )
        },
        "snapshot_artifact_version_id": dependencies["snapshot_artifact_version_id"],
        "template_comparison": {key: comparison[key] for key in ("total", "finding_summary")},
        "table_header_templates": table_header_templates,
    }


def _table_header_templates(snapshot: JsonObject) -> list[JsonObject]:
    """Return header-row templates shared by every comparable table of a column count."""
    objects = require_objects(snapshot.get("objects"), "snapshot objects")
    tables: list[JsonObject] = []
    rows_by_table: dict[str, list[JsonObject]] = {}
    paragraph_texts: dict[tuple[str, int], list[str]] = {}
    run_texts: dict[tuple[str, int], list[str]] = {}
    for item in objects:
        kind = item.get("kind")
        if kind == "table":
            tables.append(item)
            continue
        context = item.get("table_context")
        if not isinstance(context, dict):
            continue
        table_id = context.get("table_object_id")
        row_index = context.get("row_index")
        if not isinstance(table_id, str) or not table_id or type(row_index) is not int:
            continue
        if row_index < 0:
            continue
        if kind == "tr":
            rows_by_table.setdefault(table_id, []).append(item)
        elif kind in {"paragraph", "run"}:
            value = item.get("text")
            label = " ".join(value.split()) if isinstance(value, str) else ""
            if not label:
                continue
            texts = paragraph_texts if kind == "paragraph" else run_texts
            labels = texts.setdefault((table_id, row_index), [])
            if label not in labels:
                labels.append(label)

    table_numbers: dict[str, int] = {}
    groups: dict[int, list[tuple[list[int], JsonObject, tuple[list[JsonObject], int] | None]]] = {}
    for table_number, table in enumerate(tables, start=1):
        table_id = require_text(table.get("object_id"), "table object ID")
        path = table.get("path")
        evidence = table.get("evidence")
        properties = table.get("properties")
        if (
            not isinstance(path, list)
            or len(path) != 3
            or not isinstance(evidence, dict)
            or cast(JsonObject, evidence).get("top_level_body") is not True
            or not isinstance(properties, dict)
        ):
            continue
        table_properties = cast(JsonObject, properties).get("table")
        if not isinstance(table_properties, dict) or "float" in table_properties:
            continue
        column_widths = cast(JsonObject, table_properties).get("columnWidthsPt")
        if not isinstance(column_widths, list) or not column_widths:
            continue
        table_numbers[table_id] = table_number
        groups.setdefault(len(column_widths), []).append(
            (
                cast(list[int], path),
                table,
                _table_header_rows(rows_by_table.get(table_id, []), table),
            )
        )

    templates: list[JsonObject] = []
    for column_count in sorted(groups):
        entries = sorted(groups[column_count], key=lambda entry: tuple(entry[0]))
        if any(rows is None for _, _, rows in entries):
            continue
        resolved = [
            (path, table, cast(tuple[list[JsonObject], int], rows)) for path, table, rows in entries
        ]
        prefixes = {prefix for _, _, (_, prefix) in resolved}
        if len(prefixes) != 1:
            continue
        prefix = next(iter(prefixes))
        if prefix == 0 or any(prefix >= len(rows) for _, _, (rows, _) in resolved):
            continue
        _, first_table, (rows, _) = resolved[0]
        table_id = cast(str, first_table["object_id"])
        templates.append(
            {
                "column_count": column_count,
                "rows": [
                    {
                        "object_id": require_text(row.get("object_id"), "header row object ID"),
                        "location": _table_row_location(
                            paragraph_texts,
                            run_texts,
                            table_id,
                            row_index,
                            table_numbers[table_id],
                        ),
                    }
                    for row_index, row in enumerate(rows[:prefix])
                ],
            }
        )
    return templates


def _table_header_rows(
    rows: list[JsonObject], table: JsonObject
) -> tuple[list[JsonObject], int] | None:
    table_id = require_text(table.get("object_id"), "table object ID")
    table_path = cast(list[int], table["path"])
    rows_by_index: dict[int, JsonObject] = {}
    row_count: int | None = None
    for item in rows:
        context = cast(JsonObject, item["table_context"])
        if context.get("table_object_id") != table_id:
            continue
        row_index = context.get("row_index")
        context_row_count = context.get("row_count")
        if (
            type(row_index) is not int
            or type(context_row_count) is not int
            or row_index < 0
            or context_row_count < 1
            or (row_count is not None and row_count != context_row_count)
        ):
            return None
        row_count = context_row_count
        path = item.get("path")
        if (
            not isinstance(path, list)
            or len(path) != len(table_path) + 1
            or path[:-1] != table_path
            or type(path[-1]) is not int
            or path[-1] < 0
            or row_index in rows_by_index
        ):
            return None
        rows_by_index[row_index] = item
    if (
        row_count is None
        or row_count != len(rows_by_index)
        or any(index not in rows_by_index for index in range(row_count))
    ):
        return None
    ordered = [rows_by_index[index] for index in range(row_count)]
    physical_indices = [cast(list[int], row["path"])[-1] for row in ordered]
    if any(
        left >= right for left, right in zip(physical_indices, physical_indices[1:], strict=False)
    ):
        return None
    headers: list[bool] = []
    for row in ordered:
        properties = row.get("properties")
        row_properties = properties.get("row") if isinstance(properties, dict) else None
        is_header = row_properties.get("isHeader") if isinstance(row_properties, dict) else None
        if type(is_header) is not bool:
            return None
        headers.append(is_header)
    prefix = 0
    while prefix < len(headers) and headers[prefix]:
        prefix += 1
    if any(headers[prefix:]):
        return None
    return ordered, prefix


def _table_row_location(
    paragraph_texts: dict[tuple[str, int], list[str]],
    run_texts: dict[tuple[str, int], list[str]],
    table_id: str,
    row_index: int,
    table_number: int,
) -> str:
    key = (table_id, row_index)
    labels = paragraph_texts.get(key) or run_texts.get(key) or []
    base = f"Table {table_number} · R{row_index + 1}"
    return f"{base} · {' · '.join(labels)}"[:120] if labels else base


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
        {"response", "snapshot_reference"},
    )
    response_mode = payload.get("response")
    if "response" in payload and response_mode not in ("summary", "candidate"):
        raise ValueError("Template check response must be summary or candidate when provided")
    project_id = text(payload, "project_id")
    baseline_id, world_id = text(payload, "expected_baseline_id"), text(payload, "world_version_id")
    reference = (
        _snapshot_reference(payload["snapshot_reference"])
        if "snapshot_reference" in payload
        else None
    )
    if response_mode == "candidate" and reference is None:
        raise ValueError("Candidate check requires an exact format snapshot reference")
    if reference is not None and reference["baseline_id"] != baseline_id:
        raise ValueError("Format snapshot reference differs from the checked baseline")
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
    request_digest = record_digest(
        {key: value for key, value in payload.items() if key != "response"}
    )
    for saved in service.store.list_checks(project_id):
        if saved["check_id"] == identity:
            if saved.get("request_digest") != request_digest:
                raise BindingConflictError(
                    "Template check request ID was reused with different inputs"
                )
            retained_record = service.check_record(identity)
            if response_mode == "candidate":
                replay_world = service.store.get_world_metadata(
                    require_text(saved.get("world_version_id"), "saved world version ID")
                )
                return _candidate_check_response(
                    retained_record,
                    _table_header_templates(_retained_template_snapshot(service, replay_world)),
                )
            if response_mode == "summary":
                replay_view = _finding_query_view(
                    service,
                    saved,
                    _retained_check_findings(service, saved),
                )
                return _summary_check_response(retained_record, replay_view)
            return retained_record
    world = service.store.get_world(world_id)
    validate_world_for_execution(world)
    template_snapshot = _retained_template_snapshot(service, world)
    project = open_project(service.project_root(project_id))
    snapshot = project.get_format_snapshot(baseline_id, reference=reference)
    if format_snapshot_method(snapshot) != SNAPSHOT_METHOD:
        raise ValueError("DOCX format reader changed; recapture manuscript format facts")
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
    view: FindingQueryView | None = None
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
                **(
                    {"snapshot_artifact_version_id": reference["snapshot_artifact_version_id"]}
                    if reference is not None
                    else {}
                ),
            },
        }
        if response_mode == "summary":
            view = build_finding_query_view(record, snapshot, findings)
        service.store.save_check(record)
    service.prime_template_findings(
        project_id, artifact, findings, check_id=identity, snapshot=snapshot
    )
    presented = service.check_record(identity)
    if response_mode == "candidate":
        return _candidate_check_response(presented, _table_header_templates(template_snapshot))
    if view is None:
        return presented
    service.cache_finding_query_view(identity, view)
    return _summary_check_response(presented, view)
