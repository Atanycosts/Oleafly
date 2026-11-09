from pathlib import Path
from typing import cast

from research_file_workbench.common.json_io import JsonObject, load_json_object
from research_file_workbench.phase0.models import (
    ContractValueError,
    RenderProfileSpec,
    SourceArtifactSpec,
)


def _object_list(document: JsonObject, key: str) -> list[JsonObject]:
    value = document.get(key)
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise ContractValueError(f"Expected object array field: {key}")
    return cast(list[JsonObject], value)


def load_source_catalog(path: Path) -> tuple[Path, tuple[SourceArtifactSpec, ...]]:
    document = load_json_object(path)
    root_value = document.get("author_workspace_root")
    if not isinstance(root_value, str) or not root_value:
        raise ContractValueError("Expected author_workspace_root")
    artifacts = tuple(
        SourceArtifactSpec.from_json(item) for item in _object_list(document, "artifacts")
    )
    return Path(root_value), artifacts


def load_render_profiles(path: Path) -> tuple[RenderProfileSpec, ...]:
    document = load_json_object(path)
    return tuple(RenderProfileSpec.from_json(item) for item in _object_list(document, "profiles"))
