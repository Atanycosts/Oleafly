"""Strict primitive validators shared by Phase 0 contract checks."""

import re
from typing import cast

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.phase0.models import ContractValueError


def object_value(document: JsonObject, key: str) -> JsonObject:
    """Require an object at a contract boundary; raise rather than skip invalid input."""
    value = document.get(key)
    if not isinstance(value, dict):
        raise ContractValueError(f"Expected object: {key}")
    return cast(JsonObject, value)


def object_array(document: JsonObject, key: str, *, nonempty: bool = True) -> list[JsonObject]:
    """Require an object array, including its explicitly declared emptiness constraint."""
    value = document.get(key)
    if not isinstance(value, list) or (nonempty and not value):
        raise ContractValueError(f"Expected {'nonempty ' if nonempty else ''}object array: {key}")
    if not all(isinstance(item, dict) for item in value):
        raise ContractValueError(f"Invalid object array member: {key}")
    return cast(list[JsonObject], value)


def string_value(document: JsonObject, key: str) -> str:
    """Require a nonblank string and reject unresolved contract placeholders."""
    value = document.get(key)
    if not isinstance(value, str) or not value.strip() or value.startswith("to_be_"):
        raise ContractValueError(f"Expected resolved nonempty string: {key}")
    return value


def string_array(document: JsonObject, key: str, *, nonempty: bool = True) -> list[str]:
    """Require distinct nonblank strings instead of treating malformed input as empty."""
    value = document.get(key)
    if not isinstance(value, list) or (nonempty and not value):
        raise ContractValueError(f"Expected string array: {key}")
    if not all(isinstance(item, str) and item.strip() for item in value):
        raise ContractValueError(f"Invalid string array member: {key}")
    result = cast(list[str], value)
    if len(set(result)) != len(result):
        raise ContractValueError(f"Duplicate values: {key}")
    return result


def keyed_records(records: list[JsonObject], key: str) -> dict[str, JsonObject]:
    """Index records without silently overwriting duplicate identities."""
    result: dict[str, JsonObject] = {}
    for record in records:
        identity = string_value(record, key)
        if identity in result:
            raise ContractValueError(f"Duplicate {key}: {identity}")
        result[identity] = record
    return result


def require_fields(document: JsonObject, fields: set[str]) -> None:
    """Reject absent mandatory fields in one bounded contract object."""
    missing = sorted(fields - document.keys())
    if missing:
        raise ContractValueError(f"Missing required fields: {', '.join(missing)}")


def hash_value(document: JsonObject, key: str) -> str:
    """Require a lowercase SHA-256 digest, not merely a non-null value."""
    value = string_value(document, key)
    if re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ContractValueError(f"Expected lowercase SHA-256: {key}")
    return value
