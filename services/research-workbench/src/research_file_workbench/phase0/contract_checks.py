"""Public entry points for the bounded Phase 0 contract vocabulary."""

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.phase0.contract_primitives import (
    hash_value,
    keyed_records,
    object_array,
    object_value,
    require_fields,
    string_array,
    string_value,
)
from research_file_workbench.phase0.contract_schema import (
    ENTITY_REQUIRED_FIELDS,
    validate_minimum_schema,
)
from research_file_workbench.phase0.contract_semantics import (
    ACCEPTANCE_IDS,
    CACHE_DEPENDENCIES,
    CACHE_EXCLUSIONS,
    CAPABILITY_IDS,
    COLLECTION_KEYS,
    FAILURE_SCENARIO_INPUTS,
    FAILURE_SCENARIO_RESULTS,
    validate_acceptance_fixtures,
    validate_cache_invalidation,
    validate_capability_boundary,
    validate_collection_contract,
)
from research_file_workbench.phase0.models import ContractValueError


def validate_contract_content(name: str, document: JsonObject) -> None:
    """Reject empty, incomplete or contradictory Phase 0 contracts explicitly."""
    string_value(document, "contract_version")
    if name in COLLECTION_KEYS:
        validate_collection_contract(name, document)
    elif name == "capability-boundary.json":
        validate_capability_boundary(document)
    elif name == "acceptance-fixtures.json":
        validate_acceptance_fixtures(document)
    elif name == "cache-invalidation.json":
        validate_cache_invalidation(document)
    elif name == "minimum-schema.json":
        validate_minimum_schema(document)
    elif name == "digest-contract.json":
        from research_file_workbench.phase0.digests import validate_digest_contract

        validate_digest_contract(document)
    elif name == "s1-handoff-acceptance.json":
        from research_file_workbench.phase0.handoff_acceptance import validate_handoff_acceptance

        validate_handoff_acceptance(document)
    else:
        raise ContractValueError(f"No contract validator registered: {name}")


__all__ = [
    "ACCEPTANCE_IDS",
    "CACHE_DEPENDENCIES",
    "CACHE_EXCLUSIONS",
    "CAPABILITY_IDS",
    "ENTITY_REQUIRED_FIELDS",
    "FAILURE_SCENARIO_INPUTS",
    "FAILURE_SCENARIO_RESULTS",
    "hash_value",
    "keyed_records",
    "object_array",
    "object_value",
    "require_fields",
    "string_array",
    "string_value",
    "validate_contract_content",
    "validate_minimum_schema",
]
