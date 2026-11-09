import json
import math
import os
import tempfile
from pathlib import Path
from typing import cast

type JsonValue = object
type JsonObject = dict[str, object]


class JsonDocumentError(ValueError):
    """Raised when a JSON document is not a valid object."""


def _unique_object(pairs: list[tuple[str, object]]) -> JsonObject:
    document: JsonObject = {}
    for key, value in pairs:
        if key in document:
            raise JsonDocumentError(f"Duplicate JSON object key: {key}")
        document[key] = value
    return document


def _reject_constant(value: str) -> object:
    raise JsonDocumentError(f"Non-finite JSON number is not allowed: {value}")


def _finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise JsonDocumentError(f"JSON number is outside the finite float range: {value}")
    return number


def decode_json_object(value: str | bytes) -> JsonObject:
    """Decode an object, refusing ambiguous keys and non-finite numbers."""
    try:
        document: object = json.loads(
            value,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
            parse_float=_finite_float,
        )
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise JsonDocumentError(f"Cannot decode JSON object: {exc}") from exc
    if not isinstance(document, dict):
        raise JsonDocumentError("Expected a JSON object")
    return cast(JsonObject, document)


def decode_json_array(value: str | bytes) -> list[JsonValue]:
    """Decode a top-level array with the same strict key and number rules."""
    try:
        document: object = json.loads(
            value,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
            parse_float=_finite_float,
        )
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise JsonDocumentError(f"Cannot decode JSON array: {exc}") from exc
    if not isinstance(document, list):
        raise JsonDocumentError("Expected a JSON array")
    return document


def encode_json_object(value: JsonObject) -> str:
    """Serialize a deterministic JSON object; serialization failures remain explicit."""
    _validate_object_keys(value)
    try:
        return json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        )
    except (TypeError, ValueError) as exc:
        raise JsonDocumentError(f"Cannot encode JSON object: {exc}") from exc


def load_json_object(path: Path) -> JsonObject:
    """Read a strict JSON object from disk or raise a contextual read error."""
    try:
        return decode_json_object(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, JsonDocumentError) as exc:
        raise JsonDocumentError(f"Cannot read JSON object from {path}: {exc}") from exc


def write_json_object(path: Path, value: JsonObject) -> None:
    """Atomically write one JSON object inside its target directory."""
    _validate_object_keys(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=False, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, path)
    except (OSError, TypeError, ValueError):
        temporary_path.unlink(missing_ok=True)
        raise


def _validate_object_keys(value: JsonObject) -> None:
    if not isinstance(value, dict):
        raise JsonDocumentError("Expected a JSON object")
    pending: list[object] = [value]
    visited: set[int] = set()
    while pending:
        current = pending.pop()
        if isinstance(current, (dict, list, tuple)):
            if id(current) in visited:
                continue
            visited.add(id(current))
        if isinstance(current, dict):
            if any(not isinstance(key, str) for key in current):
                raise JsonDocumentError("JSON object keys must be strings")
            pending.extend(current.values())
        elif isinstance(current, (list, tuple)):
            pending.extend(current)
