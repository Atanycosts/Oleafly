from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from research_file_workbench.common.json_io import JsonObject


class ContractValueError(ValueError):
    """Raised when a contract value is missing or has the wrong type."""


def _required_string(data: JsonObject, key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ContractValueError(f"Expected non-empty string field: {key}")
    return value


def _required_bool(data: JsonObject, key: str) -> bool:
    value = data.get(key)
    if not isinstance(value, bool):
        raise ContractValueError(f"Expected boolean field: {key}")
    return value


def _string_list(data: JsonObject, key: str) -> tuple[str, ...]:
    value = data.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ContractValueError(f"Expected string array field: {key}")
    return tuple(cast(list[str], value))


def _optional_string(data: JsonObject, key: str) -> str | None:
    value = data.get(key)
    if value is not None and not isinstance(value, str):
        raise ContractValueError(f"Expected {key} to be a string or null")
    return value


def _optional_integer(data: JsonObject, key: str) -> int | None:
    value = data.get(key)
    if value is not None and not isinstance(value, int):
        raise ContractValueError(f"Expected {key} to be an integer or null")
    return value


@dataclass(frozen=True)
class SourceArtifactSpec:
    artifact_id: str
    role: str
    path: Path
    kind: str
    required: bool
    phase: str
    sha256: str | None
    manifest_sha256: str | None = None
    expected_file_count: int | None = None
    expected_total_file_size: int | None = None
    limitations: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def from_json(cls, data: JsonObject) -> "SourceArtifactSpec":
        sha256_value = data.get("sha256")
        if sha256_value is not None and not isinstance(sha256_value, str):
            raise ContractValueError("Expected sha256 to be a string or null")
        manifest_sha256 = _optional_string(data, "manifest_sha256")
        expected_file_count = _optional_integer(data, "expected_file_count")
        expected_total_file_size = _optional_integer(data, "expected_total_file_size")
        kind = _required_string(data, "kind")
        if kind not in {"file", "directory"}:
            raise ContractValueError(f"Unsupported artifact kind: {kind}")
        return cls(
            artifact_id=_required_string(data, "artifact_id"),
            role=_required_string(data, "role"),
            path=Path(_required_string(data, "path")),
            kind=kind,
            required=_required_bool(data, "required"),
            phase=_required_string(data, "phase"),
            sha256=sha256_value,
            manifest_sha256=manifest_sha256,
            expected_file_count=expected_file_count,
            expected_total_file_size=expected_total_file_size,
            limitations=_string_list(data, "limitations"),
        )


@dataclass(frozen=True)
class RenderProfileSpec:
    profile_id: str
    renderer: str
    executable_path: Path | None
    executable_sha256: str | None
    file_version: str | None
    status: str
    required_settings: JsonObject
    limitations: tuple[str, ...]

    @classmethod
    def from_json(cls, data: JsonObject) -> "RenderProfileSpec":
        executable_path = _optional_string(data, "executable_path")
        executable_sha256 = _optional_string(data, "executable_sha256")
        file_version = _optional_string(data, "file_version")
        settings = data.get("required_settings", {})
        if not isinstance(settings, dict):
            raise ContractValueError("Expected required_settings to be an object")
        return cls(
            profile_id=_required_string(data, "profile_id"),
            renderer=_required_string(data, "renderer"),
            executable_path=Path(executable_path) if executable_path else None,
            executable_sha256=executable_sha256,
            file_version=file_version,
            status=_required_string(data, "status"),
            required_settings=cast(JsonObject, settings),
            limitations=_string_list(data, "limitations"),
        )
