"""Check frozen S1 handoff expectations without implementing the planned operations."""

import re

from research_file_workbench.common.json_io import JsonObject, JsonValue
from research_file_workbench.phase0.contract_checks import (
    CACHE_DEPENDENCIES,
    keyed_records,
    object_array,
    object_value,
    string_array,
    string_value,
)
from research_file_workbench.phase0.models import ContractValueError

CASE_IDS = {
    "material_directory": {
        "materials-directory-does-not-read",
        "materials-content-page-records-exact-read",
        "materials-continuation-retains-version",
    },
    "reading_bookmarks": {
        "bookmark-actual-read",
        "bookmark-unread-claim",
        "bookmark-baseline-change",
        "bookmark-delete-preserves-records",
    },
    "author_decisions": {
        "decisions-scope-and-confirmation",
        "decisions-client-cannot-confirm",
        "decisions-local-scope-not-s1",
        "decisions-trusted-document-confirmation",
    },
    "cache_validity": {
        "cache-unchanged-hit",
        "cache-source-change",
        "cache-parser-change",
        "cache-renderer-change",
        "cache-font-change",
        "cache-display-change",
        "cache-pdf-change",
        "cache-unrelated-rule-change",
        "cache-insufficient-coverage",
        "cache-missing-dependency",
    },
}

CACHE_CASE_CHANGES = {
    "cache-unchanged-hit": set(),
    "cache-source-change": {
        "source_artifact_hash",
        "structural_index_id",
        "rendered_pdf_hash",
        "baseline_id",
    },
    "cache-parser-change": {"parser_version", "structural_index_id"},
    "cache-renderer-change": {"renderer_executable_hash", "rendered_pdf_hash"},
    "cache-font-change": {"font_set_hash", "rendered_pdf_hash"},
    "cache-display-change": {"renderer_settings", "rendered_pdf_hash"},
    "cache-pdf-change": {"rendered_pdf_hash"},
    "cache-unrelated-rule-change": {"journal_rule_version"},
    "cache-insufficient-coverage": set(),
    "cache-missing-dependency": set(),
}


def validate_handoff_acceptance(document: JsonObject) -> None:
    """Reject incomplete or contradictory specifications; this is not an S1 runtime test."""
    _check_names(document)
    for key, expected in {
        "specification_phase": "phase0",
        "target_phase": "S1",
        "validation_scope": "acceptance_specification_only",
        "implementation_status": "planned",
    }.items():
        if document.get(key) != expected:
            raise ContractValueError(f"Handoff specification must declare {key}={expected}")
    if string_array(document, "requirement_refs") != ["13.7", "15"]:
        raise ContractValueError("Handoff specification must bind v1.2 requirements 13.7 and 15")
    _validate_materials(object_value(document, "material_directory"))
    _validate_bookmarks(object_value(document, "reading_bookmarks"))
    _validate_decisions(object_value(document, "author_decisions"))
    _validate_cache(object_value(document, "cache_validity"))


def _check_names(value: JsonValue) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            # JSON field names follow snake_case; stable identifiers use kebab-case.
            if re.fullmatch(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*", key) is None:
                raise ContractValueError(f"Invalid acceptance field name: {key}")
            if key.endswith("_id") or key.endswith("_ids"):
                identifiers = item if isinstance(item, list) else [item]
                for identity in identifiers:
                    if identity is not None and (
                        not isinstance(identity, str)
                        or re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", identity) is None
                    ):
                        raise ContractValueError(f"Invalid stable identifier: {key}")
            _check_names(item)
    elif isinstance(value, list):
        for item in value:
            _check_names(item)


def _cases(section: JsonObject, name: str) -> list[JsonObject]:
    records = keyed_records(object_array(section, "cases"), "fixture_id")
    if set(records) != CASE_IDS[name]:
        raise ContractValueError(f"Missing or unknown handoff acceptance cases: {name}")
    for case in records.values():
        object_value(case, "input")
        object_value(case, "expected")
    return list(records.values())


def _expect(case: JsonObject, expected: JsonObject) -> None:
    actual = object_value(case, "expected")
    if actual != expected or any(
        type(actual[key]) is not type(value) for key, value in expected.items()
    ):
        raise ContractValueError(f"Contradictory acceptance expectation: {case['fixture_id']}")


def _boolean(record: JsonObject, key: str) -> bool:
    value = record.get(key)
    if type(value) is not bool:
        raise ContractValueError(f"Expected acceptance boolean: {key}")
    return value


def _validate_materials(section: JsonObject) -> None:
    string_value(section, "baseline_id")
    string_value(section, "selection_method_version")
    materials = keyed_records(object_array(section, "materials"), "material_id")
    entries: list[str] = []
    missing: list[str] = []
    forbidden: list[str] = []
    relations: set[str] = set()
    for identity, material in materials.items():
        string_value(material, "artifact_version_id")
        relation = string_value(material, "relation")
        if relation not in {"target_region", "neighbor", "explicit_relation"}:
            raise ContractValueError("Material fixture has no declared selection reason")
        relations.add(relation)
        available = _boolean(material, "available")
        authorized = _boolean(material, "authorized")
        (forbidden if not authorized else entries if available else missing).append(identity)
    if not all((entries, missing, forbidden)) or relations != {
        "target_region",
        "neighbor",
        "explicit_relation",
    }:
        raise ContractValueError("Material fixture must cover neighbors, gaps and access exclusion")
    previous_returned: set[str] = set()
    for case in _cases(section, "material_directory"):
        request = object_value(case, "input")
        kind = string_value(request, "response_kind")
        returned = string_array(request, "returned_material_ids", nonempty=False)
        if kind not in {"directory", "content"} or not set(returned) <= set(entries):
            raise ContractValueError("Material request has an unsupported or unavailable selection")
        if kind == "directory" and returned:
            raise ContractValueError("Directory responses cannot declare returned content")
        if kind == "content" and not returned:
            raise ContractValueError("Content fixture must exercise actual material delivery")
        expected_kind = (
            "directory" if case["fixture_id"] == "materials-directory-does-not-read" else "content"
        )
        if kind != expected_kind:
            raise ContractValueError("Material fixture no longer exercises its required scenario")
        if previous_returned & set(returned):
            raise ContractValueError("Consecutive material fixtures must return disjoint pages")
        previous_returned.update(returned)
        _expect(
            case,
            {
                "entry_ids": entries,
                "missing_ids": missing,
                "unread_ids": [identity for identity in entries if identity not in returned],
                "actual_read_ids": returned,
                "forbidden_ids": forbidden,
                "expected_verdict": "partial",
            },
        )


def _validate_bookmarks(section: JsonObject) -> None:
    baseline = string_value(section, "baseline_id")
    string_value(section, "task_id")
    read_record = string_value(section, "read_record_id")
    materials = string_array(section, "material_ids")
    actual = string_array(section, "actual_read_ids")
    retained = string_array(section, "retained_ids")
    if not set(actual) < set(materials) or read_record not in retained:
        raise ContractValueError("Bookmark fixture must retain its receipt and an unread range")
    for case in _cases(section, "reading_bookmarks"):
        request = object_value(case, "input")
        operation = string_value(request, "operation")
        if operation not in {"save", "read", "delete"}:
            raise ContractValueError("Unknown bookmark fixture operation")
        current = string_value(request, "current_baseline_id")
        claimed = string_array(request, "claimed_read_ids")
        if not set(claimed) <= set(materials):
            raise ContractValueError("Bookmark claim references missing material")
        accepted = claimed == actual
        identity = case["fixture_id"]
        expected_operation = {
            "bookmark-actual-read": "save",
            "bookmark-unread-claim": "save",
            "bookmark-baseline-change": "read",
            "bookmark-delete-preserves-records": "delete",
        }[str(identity)]
        if (
            operation != expected_operation
            or accepted != (identity != "bookmark-unread-claim")
            or (current != baseline) != (identity == "bookmark-baseline-change")
        ):
            raise ContractValueError("Bookmark fixture no longer exercises its required scenario")
        _expect(
            case,
            {
                "expected_verdict": "accepted" if accepted else "rejected",
                "bookmark_baseline_id": baseline,
                "validity": "CURRENT" if current == baseline else "STALE",
                "actual_read_ids": actual,
                "unread_ids": [identity for identity in materials if identity not in actual],
                "retained_ids": retained,
                "bookmark_exists": accepted and operation != "delete",
            },
        )


def _validate_decisions(section: JsonObject) -> None:
    decisions = keyed_records(object_array(section, "decisions"), "decision_id")
    for decision in decisions.values():
        scope = string_value(decision, "scope")
        string_value(decision, "project_id")
        string_value(decision, "language")
        _boolean(decision, "confirmed")
        if scope == "DOCUMENT":
            string_value(decision, "document_id")
        elif scope != "PROJECT" or decision.get("document_id") is not None:
            raise ContractValueError("Decision fixture has an invalid S1 scope")
    for case in _cases(section, "author_decisions"):
        request = object_value(case, "input")
        for key in ("project_id", "document_id", "language"):
            string_value(request, key)
        operation = string_value(request, "operation")
        actor = string_value(request, "actor_kind")
        scope = string_value(request, "requested_scope")
        if operation not in {"list", "confirm"} or actor not in {"ordinary_client", "trusted_user"}:
            raise ContractValueError("Unknown decision fixture operation or actor")
        if scope not in {"DOCUMENT", "PROJECT", "LOCAL", "SECTION", "PROFILE"}:
            raise ContractValueError("Unknown requested decision scope")
        visible = (
            [
                identity
                for identity, decision in decisions.items()
                if decision["confirmed"] is True
                and decision["project_id"] == request["project_id"]
                and decision["language"] == request["language"]
                and (
                    decision["scope"] == "PROJECT"
                    or decision["document_id"] == request["document_id"]
                )
            ]
            if operation == "list"
            else []
        )
        confirmed = (
            operation == "confirm" and actor == "trusted_user" and scope in {"DOCUMENT", "PROJECT"}
        )
        scenario = {
            "decisions-scope-and-confirmation": ("list", "ordinary_client", "DOCUMENT"),
            "decisions-client-cannot-confirm": ("confirm", "ordinary_client", "DOCUMENT"),
            "decisions-local-scope-not-s1": ("confirm", "trusted_user", "LOCAL"),
            "decisions-trusted-document-confirmation": ("confirm", "trusted_user", "DOCUMENT"),
        }[str(case["fixture_id"])]
        if (operation, actor, scope) != scenario:
            raise ContractValueError("Decision fixture no longer exercises its required scenario")
        if operation == "list" and (not visible or len(visible) == len(decisions)):
            raise ContractValueError("Decision fixture must exercise included and excluded scopes")
        if operation == "list":
            if {decisions[identity]["scope"] for identity in visible} != {"DOCUMENT", "PROJECT"}:
                raise ContractValueError("Decision fixture must include both supported scopes")
            exclusions = {
                "unconfirmed": any(
                    decision["confirmed"] is False for decision in decisions.values()
                ),
                "project": any(
                    decision["project_id"] != request["project_id"]
                    for decision in decisions.values()
                ),
                "document": any(
                    decision["scope"] == "DOCUMENT"
                    and decision["project_id"] == request["project_id"]
                    and decision["document_id"] != request["document_id"]
                    for decision in decisions.values()
                ),
                "language": any(
                    decision["language"] != request["language"] for decision in decisions.values()
                ),
            }
            if not all(exclusions.values()):
                raise ContractValueError("Decision fixture omits a required scope exclusion")
        _expect(
            case,
            {
                "expected_verdict": "accepted" if operation == "list" or confirmed else "rejected",
                "visible_decision_ids": visible,
                "creates_author_decision": confirmed,
                "creates_semantic_pass": False,
            },
        )


def _validate_cache(section: JsonObject) -> None:
    entries = keyed_records(object_array(section, "entries"), "cache_entry_id")
    result_types: set[str] = set()
    for entry in entries.values():
        result_type = string_value(entry, "result_type")
        dependencies = set(string_array(entry, "dependency_keys"))
        if result_type not in CACHE_DEPENDENCIES or dependencies != CACHE_DEPENDENCIES[result_type]:
            raise ContractValueError("Cache fixture dependencies differ from the frozen contract")
        result_types.add(result_type)
        string_array(entry, "coverage")
    if result_types != set(CACHE_DEPENDENCIES) - {"rule_check"}:
        raise ContractValueError("Cache fixtures must cover every S1 result type")
    known_dependencies = set().union(*CACHE_DEPENDENCIES.values()) | {"journal_rule_version"}
    for case in _cases(section, "cache_validity"):
        request = object_value(case, "input")
        changed = set(string_array(request, "changed_dependencies", nonempty=False))
        missing = set(string_array(request, "missing_dependencies", nonempty=False))
        coverage = set(string_array(request, "requested_coverage"))
        fallback = set(string_array(request, "fallback_scope", nonempty=False))
        if not (changed | missing) <= known_dependencies or not fallback <= entries.keys():
            raise ContractValueError("Unknown cache fixture dependency or fallback target")
        identity = str(case["fixture_id"])
        if changed != CACHE_CASE_CHANGES[identity]:
            raise ContractValueError("Cache fixture no longer exercises its required change")
        if missing != ({"parser_version"} if identity == "cache-missing-dependency" else set()):
            raise ContractValueError("Cache fixture no longer exercises required dependency gaps")
        insufficient = any(
            not coverage <= set(string_array(entry, "coverage")) for entry in entries.values()
        )
        if insufficient != (identity == "cache-insufficient-coverage"):
            raise ContractValueError("Cache fixture no longer exercises required coverage")
        completeness = "incomplete" if missing else "complete"
        if request.get("dependency_completeness") != completeness or (not missing and fallback):
            raise ContractValueError("Cache fixture completeness conflicts with fallback scope")
        missing_targets = {
            identity
            for identity, entry in entries.items()
            if missing & set(string_array(entry, "dependency_keys"))
        }
        if missing and (not missing_targets or not missing_targets <= fallback):
            raise ContractValueError("Cache fallback omits a result with missing dependencies")
        impacted = [
            identity
            for identity, entry in entries.items()
            if changed & set(string_array(entry, "dependency_keys"))
            or identity in fallback
            or not coverage <= set(string_array(entry, "coverage"))
        ]
        _expect(
            case,
            {
                "expected_impacted_ids": impacted,
                "expected_preserved_ids": [
                    identity for identity in entries if identity not in impacted
                ],
                "expected_verdict": "miss" if impacted else "hit",
                "creates_semantic_pass": False,
                "creates_read_receipt": False,
            },
        )
