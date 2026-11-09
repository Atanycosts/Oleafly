"""Validation for named Phase 0 contract semantics and frozen vocabularies."""

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.phase0.contract_primitives import (
    hash_value,
    keyed_records,
    object_array,
    object_value,
    string_array,
    string_value,
)
from research_file_workbench.phase0.models import ContractValueError

CAPABILITY_IDS = {
    "docx-package-inventory",
    "docx-regional-text",
    "docx-basic-table-grid",
    "docx-omml-source",
    "docx-field-boundaries",
    "docx-image-relationships",
    "docx-styles-and-layout",
    "docx-complex-embedded-objects",
    "docx-unknown-or-broken-content",
}
ACCEPTANCE_IDS = {
    "source-catalog-all-required-present",
    "english-baseline-does-not-use-chinese-pdf",
    "legacy-doc-is-not-s1-docx",
    "pinned-renderer-profile",
    "missing-word-is-explicit",
    "fixture-groups-reviewed-with-evidence",
}
CACHE_DEPENDENCIES = {
    "package_inventory": {"source_artifact_hash", "inventory_tool_version", "inventory_options"},
    "structural_index": {"source_artifact_hash", "parser_version", "parser_options"},
    "rendered_pages": {
        "source_artifact_hash",
        "renderer_executable_hash",
        "renderer_settings",
        "font_set_hash",
    },
    "page_mapping": {"structural_index_id", "rendered_pdf_hash", "mapping_method_version"},
    "rule_check": {
        "evidence_versions",
        "rule_pack_version",
        "checker_version",
        "applicable_author_decisions",
    },
    "task_material_directory": {
        "baseline_id",
        "task_scope",
        "selection_method_version",
        "access_scope",
    },
}
CACHE_EXCLUSIONS = {
    "package_inventory": {"journal_rule_version", "render_font_set"},
    "structural_index": {"journal_rule_version", "render_font_set"},
    "rendered_pages": {"journal_rule_version"},
    "page_mapping": {"journal_rule_version"},
    "rule_check": {"unrelated_renderer_configuration"},
    "task_material_directory": {"unrelated_author_decisions"},
}
FAILURE_SCENARIO_INPUTS = {
    "renderer_unavailable": {"render_profile_id": "microsoft-word-local"},
    "render_failure": {"render_profile_id": "controlled-failing-renderer"},
    "bypass_attempt": {"request_kind": "fingerprint_output_inside_author_workspace"},
}
FAILURE_SCENARIO_RESULTS = {
    "renderer_unavailable": {
        "status": "renderer_unavailable",
        "source_unchanged": True,
        "output_created": False,
    },
    "render_failure": {
        "status": "render_failed",
        "source_unchanged": True,
        "output_created": False,
        "structure_result_preserved": True,
    },
    "bypass_attempt": {
        "status": "access_denied",
        "source_unchanged": True,
        "content_disclosed": False,
    },
}
COLLECTION_KEYS = {
    "source-catalog.json": ("artifacts", "artifact_id"),
    "render-environments.json": ("profiles", "profile_id"),
    "render-baselines.json": ("baselines", "baseline_id"),
    "fixture-matrix.json": ("fixture_groups", "group_id"),
    "docx-fixture-catalog.json": ("fixtures", "sample_id"),
    "native-docx-fixture-catalog.json": ("fixtures", "sample_id"),
    "non-docx-scenarios.json": ("scenarios", "scenario_id"),
}


def validate_collection_contract(name: str, document: JsonObject) -> None:
    """Validate one collection-shaped Phase 0 contract."""
    collection, identity = COLLECTION_KEYS[name]
    records = keyed_records(object_array(document, collection), identity)
    if name == "source-catalog.json":
        _validate_source_catalog(document, records)
    elif name == "render-baselines.json":
        _validate_render_baselines(records)
    elif name == "fixture-matrix.json":
        _validate_fixture_matrix(records)
    elif name == "non-docx-scenarios.json":
        _validate_non_docx_scenarios(records)
    elif name.endswith("docx-fixture-catalog.json"):
        _validate_docx_fixture_catalog(records)


def _validate_source_catalog(document: JsonObject, records: dict[str, JsonObject]) -> None:
    string_value(document, "author_workspace_root")
    for record in records.values():
        if record.get("kind") == "file":
            hash_value(record, "sha256")
        elif record.get("kind") == "directory":
            hash_value(record, "manifest_sha256")
        else:
            raise ContractValueError("Unknown source artifact kind")


def _validate_render_baselines(records: dict[str, JsonObject]) -> None:
    for record in records.values():
        hash_value(record, "source_sha256")
        hash_value(record, "pdf_sha256")
        object_array(record, "pages")


def _validate_fixture_matrix(records: dict[str, JsonObject]) -> None:
    for record in records.values():
        string_array(record, "required_cases")
        string_value(record, "annotation_status")


def _validate_non_docx_scenarios(records: dict[str, JsonObject]) -> None:
    if set(records) != set(FAILURE_SCENARIO_INPUTS):
        raise ContractValueError("Missing or unknown non-DOCX failure scenario")
    for identity, record in records.items():
        string_value(record, "source_sample_id")
        string_value(record, "evidence")
        expected = object_value(record, "expected_result")
        required = FAILURE_SCENARIO_RESULTS[identity]
        if (
            object_value(record, "input") != FAILURE_SCENARIO_INPUTS[identity]
            or expected != required
            or any(type(expected[key]) is not type(value) for key, value in required.items())
        ):
            raise ContractValueError(f"Changed failure scenario semantics: {identity}")


def _validate_docx_fixture_catalog(records: dict[str, JsonObject]) -> None:
    for record in records.values():
        hash_value(record, "sha256")
        string_value(record, "relative_path")
        for case in keyed_records(object_array(record, "cases"), "case_id").values():
            if case.get("implementation_status") not in {
                "generated",
                "generated_native",
                "unsupported",
                "not_generated",
            }:
                raise ContractValueError("Unknown fixture implementation_status")


def validate_capability_boundary(document: JsonObject) -> None:
    """Validate frozen capability vocabulary and support levels."""
    records = keyed_records(object_array(document, "capabilities"), "capability_id")
    if set(records) != CAPABILITY_IDS:
        raise ContractValueError("Capability set differs from the Phase 0 boundary")
    for record in records.values():
        string_array(record, "object_scope")
        string_array(record, "required_evidence")
        if record.get("support_level") not in {
            "required_structural_result",
            "register_and_render",
            "declared_unsupported",
        }:
            raise ContractValueError("Unknown capability support_level")


def validate_acceptance_fixtures(document: JsonObject) -> None:
    """Require complete frozen acceptance fixture set and pass expectations."""
    records = keyed_records(object_array(document, "fixtures"), "fixture_id")
    if set(records) != ACCEPTANCE_IDS:
        raise ContractValueError("Missing or unknown Phase 0 acceptance fixture")
    if any(record.get("expected_verdict") != "pass" for record in records.values()):
        raise ContractValueError("Phase 0 completion requires all acceptance verdicts to be pass")


def validate_cache_invalidation(document: JsonObject) -> None:
    """Validate exact cache dependencies and explicit exclusions."""
    records = keyed_records(object_array(document, "result_types"), "result_type")
    if set(records) != set(CACHE_DEPENDENCIES):
        raise ContractValueError("Incomplete cache result types")
    string_array(document, "rules")
    for identity, record in records.items():
        dependencies = set(string_array(record, "depends_on"))
        excluded = set(string_array(record, "must_not_depend_on"))
        if (
            dependencies != CACHE_DEPENDENCIES[identity]
            or excluded != CACHE_EXCLUSIONS[identity]
            or dependencies & excluded
        ):
            raise ContractValueError(f"Missing or contradictory cache dependencies: {identity}")
