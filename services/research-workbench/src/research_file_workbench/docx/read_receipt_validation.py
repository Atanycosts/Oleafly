"""Validation primitives shared by the persistent DOCX read-receipt models.

The receipt models own their data shape and serialization.  This module owns the
small, strict validation operations used by those models so they do not each
carry a second implementation of JSON and scalar validation.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Literal, cast

from research_file_workbench.common.json_io import JsonObject

_PARSE_STATUSES = {"parsed", "partial", "unsupported", "failed", "unverified"}
_DIRECTORY_LISTING_TYPES = {"directory", "directory_listing"}

ParseStatus = Literal["parsed", "partial", "unsupported", "failed", "unverified"]


class ReadReceiptError(ValueError):
    """Raised when a read receipt is incomplete or internally inconsistent."""


def _first_seen(values: Iterable[str]) -> tuple[str, ...]:
    found: list[str] = []
    for value in values:
        if value not in found:
            found.append(value)
    return tuple(found)


def _require_text(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReadReceiptError(f"{name} must be a nonblank string")
    return value


def _require_text_sequence(values: tuple[str, ...], name: str, *, allow_empty: bool = True) -> None:
    if not allow_empty and not values:
        raise ReadReceiptError(f"{name} must not be empty")
    if not all(isinstance(item, str) and item.strip() for item in values):
        raise ReadReceiptError(f"{name} must contain nonblank strings")


def _require_unique(values: tuple[str, ...], name: str) -> None:
    if len(set(values)) != len(values):
        raise ReadReceiptError(f"{name} must not contain duplicates")


def _validate_timestamp(value: str) -> None:
    _require_text(value, "created_at")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ReadReceiptError("created_at must be an RFC 3339 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ReadReceiptError("created_at must include an explicit timezone offset")
    if parsed.astimezone(UTC).utcoffset() is None:
        raise ReadReceiptError("created_at has an invalid timezone offset")


def _object(value: object, name: str) -> JsonObject:
    if not isinstance(value, dict):
        raise ReadReceiptError(f"{name} must be a JSON object")
    return cast(JsonObject, value)


def _string(document: JsonObject, key: str) -> str:
    return _require_text(document.get(key), key)


def _string_array(document: JsonObject, key: str, *, allow_empty: bool) -> list[str]:
    value = document.get(key)
    if not isinstance(value, list):
        raise ReadReceiptError(f"{key} must be a JSON array")
    result = [_require_text(item, f"{key}[]") for item in value]
    if not allow_empty and not result:
        raise ReadReceiptError(f"{key} must not be empty")
    return result


def _object_array(document: JsonObject, key: str) -> list[object]:
    value = document.get(key)
    if not isinstance(value, list):
        raise ReadReceiptError(f"{key} must be a JSON array")
    return value


def _optional_nonnegative_int(document: JsonObject, key: str) -> int | None:
    value = document.get(key)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ReadReceiptError(f"{key} must be a nonnegative integer or null")
    return value


def _positive_int(document: JsonObject, key: str) -> int:
    value = document.get(key)
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ReadReceiptError(f"{key} must be a positive integer")
    return value
