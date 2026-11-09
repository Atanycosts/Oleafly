"""Validation for the shared Phase 0 minimum schema contract."""

import re

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.phase0.contract_primitives import (
    object_value,
    require_fields,
    string_array,
    string_value,
)
from research_file_workbench.phase0.models import ContractValueError

ENTITY_REQUIRED_FIELDS = {
    "artifact_version": {
        "artifact_id",
        "version_id",
        "kind",
        "sha256",
        "source_kind",
        "limitations",
    },
    "baseline": {
        "baseline_id",
        "artifact_version_ids",
        "author_decision_version_ids",
        "source_kind",
        "created_at",
    },
    "task": {"task_id", "baseline_id", "scope", "status", "actual_read_ranges", "unresolved_items"},
    "evidence_item": {
        "evidence_id",
        "evidence_version",
        "kind",
        "artifact_version_id",
        "object_locator",
        "parse_status",
        "limitations",
        "dependencies",
        "statement",
        "scope",
        "extraction_method",
        "extraction_method_version",
        "verification_record_ids",
    },
    "verification_record": {
        "verification_id",
        "target_versions",
        "scope",
        "method",
        "method_version",
        "verdict",
        "evidence_refs",
        "limitations",
        "actor_id",
        "created_at",
        "dependencies",
    },
    "read_baseline_request": {
        "request_id",
        "request_digest",
        "project_id",
        "actor_id",
        "expected_baseline_id",
        "artifact_version_ids",
        "author_decision_version_ids",
        "rule_bindings",
        "created_at",
    },
    "read_baseline_result": {
        "request_id",
        "request_digest",
        "status",
        "previous_baseline_id",
        "result_baseline_id",
        "invalidated_refs",
        "created_at",
    },
    "read_record": {
        "read_record_id",
        "task_id",
        "returned_versions",
        "ranges",
        "truncation",
        "unread_ranges",
        "actor_id",
        "client_id",
        "created_at",
    },
    "task_material_directory": {
        "material_directory_id",
        "baseline_id",
        "task_scope",
        "entries",
        "gaps",
        "selection_method_version",
    },
    "author_decision": {
        "decision_id",
        "version_id",
        "decision_type",
        "content",
        "scope",
        "applicability",
        "confirmed_by",
        "confirmed_at",
        "invalidation_conditions",
    },
    "handoff_bookmark": {
        "bookmark_id",
        "task_id",
        "baseline_id",
        "actual_read_ranges",
        "material_refs",
        "unresolved_items",
        "notes",
        "validity",
    },
    "cache_entry": {
        "cache_entry_id",
        "result_type",
        "dependency_fingerprint",
        "coverage",
        "limitations",
        "producer_version",
        "created_at",
    },
}


def validate_minimum_schema(document: JsonObject) -> None:
    """Validate entity fields, references, and semantic declarations in minimum-schema."""
    conventions = object_value(document, "conventions")
    for key in (
        "identifier_format",
        "version_format",
        "timestamp_format",
        "path_format",
        "hash_format",
        "references",
    ):
        string_value(conventions, key)

    entities = object_value(document, "entities")
    require_fields(entities, set(ENTITY_REQUIRED_FIELDS))
    for name, required_fields in ENTITY_REQUIRED_FIELDS.items():
        entity = object_value(entities, name)
        required = set(string_array(entity, "required"))
        fields = object_value(entity, "fields")
        if not required_fields <= required or not required <= fields.keys():
            raise ContractValueError(f"Incomplete required entity fields: {name}")
        _validate_entity_fields(entities, fields)

    evidence = object_value(object_value(entities, "evidence_item"), "fields")
    if "verification_status" in evidence:
        raise ContractValueError("verification_status must be derived from verification records")
    semantics = object_value(document, "semantics")
    for key in ("verification", "freshness", "rebaseline", "source_dependencies", "read_receipts"):
        string_array(semantics, key)


def _validate_entity_fields(entities: JsonObject, fields: JsonObject) -> None:
    """Validate field descriptors and references for one minimum-schema entity."""
    for field_name in fields:
        descriptor = object_value(fields, field_name)
        type_name = string_value(descriptor, "type")
        if type_name == "enum":
            string_array(descriptor, "values")
        for entity_name, reference_name in re.findall(r"ref:([a-z_]+)\.([a-z_]+)", type_name):
            target = object_value(object_value(entities, entity_name), "fields")
            if reference_name not in target:
                raise ContractValueError(f"Unknown schema reference: {type_name}")
