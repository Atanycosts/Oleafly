"""Build an isolated Phase 0 evidence project for contract tests."""

from __future__ import annotations

from pathlib import Path, PurePosixPath
from shutil import copy2, copytree
from typing import cast

from research_file_workbench.common.filesystem import snapshot_directory
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import (
    JsonObject,
    JsonValue,
    decode_json_object,
    write_json_object,
)

_PRIVATE_CONTRACTS = {"source-catalog.json", "render-baselines.json"}
_TEST_PROJECT_ROOT = "controlled-phase0-project-root"
_TEST_AUTHOR_ROOT = "controlled-phase0-author-workspace"


def build_complete_project(project_root: Path, target: Path) -> Path:
    """Copy frozen evidence and relocate environment-bound identities into ``target``.

    Fixture DOCX/PDF/PNG bytes and independent annotations are copied unchanged. The author
    workspace and renderer executable are controlled placeholders whose identities are updated
    in the copied contracts. Test-only source and render-baseline contracts replace the
    repository's private historical inputs. This lets contract tests exercise the complete
    validator without reading an author directory or requiring the original WPS installation.
    """
    copy_public_phase0_contracts(project_root, target)
    _copy_public_annotations(project_root, target)
    copytree(
        project_root / "tests/fixtures/docx",
        target / "tests/fixtures/docx",
    )
    report_root = target / "reports/phase0"
    report_root.mkdir(parents=True)
    copytree(project_root / "reports/phase0/fixtures", report_root / "fixtures")
    for name in ("fixture-render-catalog.json", "fixture-page-index.json"):
        copy2(project_root / "reports/phase0" / name, report_root / name)

    render_environment_path = target / "contracts/phase0/render-environments.json"
    render_environment = _load_json(render_environment_path)
    original_renderer_path = _profile_renderer_path(render_environment)
    original_report_root = _report_root(target / "reports/phase0/fixture-render-catalog.json")
    controlled_renderer = target / "controlled-renderer" / "wps.exe"
    controlled_renderer.parent.mkdir(parents=True, exist_ok=True)
    controlled_renderer.write_bytes(b"research-file-workbench phase0 renderer placeholder\n")

    replacements = {
        original_renderer_path: controlled_renderer.as_posix(),
        original_report_root: target.as_posix(),
        project_root.as_posix(): target.as_posix(),
    }
    _rewrite_project_json(
        target,
        replacements,
    )

    render_environment = _load_json(render_environment_path)
    profile = _profile(render_environment)
    profile["executable_path"] = controlled_renderer.as_posix()
    profile["executable_sha256"] = sha256_file(controlled_renderer)
    write_json_object(render_environment_path, render_environment)

    apply_phase0_test_contracts(target)
    return target


def copy_public_phase0_contracts(project_root: Path, target: Path) -> None:
    """Copy public contracts while omitting private historical source and render inputs."""
    copytree(
        project_root / "contracts",
        target / "contracts",
        ignore=_ignore_private_contracts,
    )


def apply_phase0_test_contracts(project_root: Path) -> None:
    """Apply self-contained source and render-baseline inputs to a copied Phase 0 project."""
    fixture_root = Path(__file__).resolve().parents[1] / "fixtures" / "phase0"
    contract_root = project_root / "contracts" / "phase0"
    contract_root.mkdir(parents=True, exist_ok=True)

    source_catalog = _load_json(fixture_root / "source-catalog.json")
    controlled_author_root = project_root / _TEST_AUTHOR_ROOT
    source_catalog["author_workspace_root"] = controlled_author_root.as_posix()
    for artifact in _objects(source_catalog, "artifacts"):
        artifact["path"] = _localize_controlled_path(
            _text(artifact, "path"),
            marker=_TEST_AUTHOR_ROOT,
            target=controlled_author_root,
        )
    _materialize_author_workspace(source_catalog, controlled_author_root)
    write_json_object(contract_root / "source-catalog.json", source_catalog)

    render_baselines = _load_json(fixture_root / "render-baselines.json")
    localized = _rewrite_value(
        render_baselines,
        {_TEST_PROJECT_ROOT: project_root.as_posix()},
    )
    render_baselines = cast(JsonObject, localized)
    source_hash = _artifact_hash(source_catalog, "ijam-english-working-docx")
    for baseline in _objects(render_baselines, "baselines"):
        if baseline.get("source_artifact_id") == "ijam-english-working-docx":
            baseline["source_sha256"] = source_hash
    write_json_object(contract_root / "render-baselines.json", render_baselines)


def _copy_public_annotations(project_root: Path, target: Path) -> None:
    annotation_root = project_root / "annotations/s1"
    destination = target / "annotations/s1"
    destination.mkdir(parents=True)
    for source in sorted(annotation_root.glob("s1-*")):
        if source.is_dir():
            copytree(source, destination / source.name)


def _ignore_private_contracts(directory: str, names: list[str]) -> set[str]:
    if Path(directory).name != "phase0":
        return set()
    return set(names) & _PRIVATE_CONTRACTS


def _localize_controlled_path(value: str, *, marker: str, target: Path) -> str:
    path = PurePosixPath(value.replace("\\", "/"))
    try:
        relative = path.relative_to(marker)
    except ValueError as exc:
        raise AssertionError(f"Test path is outside {marker}: {value}") from exc
    return (target / Path(*relative.parts)).as_posix()


def _rewrite_project_json(target: Path, replacements: dict[str, str]) -> None:
    """Relocate known path prefixes in copied JSON without touching repository evidence."""
    for path in target.rglob("*.json"):
        document = _load_json(path)
        rewritten = _rewrite_value(document, replacements)
        write_json_object(path, cast(JsonObject, rewritten))


def _rewrite_value(value: JsonValue, replacements: dict[str, str]) -> JsonValue:
    if isinstance(value, str):
        normalized = value.replace("\\", "/")
        for old, new in replacements.items():
            old_normalized = old.replace("\\", "/").rstrip("/")
            if normalized == old_normalized:
                return new
            if normalized.startswith(old_normalized + "/"):
                suffix = normalized[len(old_normalized) + 1 :]
                return f"{new.rstrip('/')}/{suffix}"
        return value
    if isinstance(value, list):
        return [_rewrite_value(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: _rewrite_value(item, replacements) for key, item in value.items()}
    return value


def _materialize_author_workspace(source_catalog: JsonObject, root: Path) -> None:
    """Create controlled source artifacts and bind catalog identities to their actual bytes."""
    root.mkdir(parents=True, exist_ok=True)
    original_root = _text(source_catalog, "author_workspace_root")
    for artifact in _objects(source_catalog, "artifacts"):
        path_value = _text(artifact, "path")
        relative = path_value.replace("\\", "/")[len(original_root.replace("\\", "/")) :].lstrip(
            "/"
        )
        path = root / PurePosixPath(relative)
        kind = artifact.get("kind")
        if kind == "file":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                f"controlled-phase0-artifact:{artifact['artifact_id']}",
                encoding="utf-8",
            )
            artifact["sha256"] = sha256_file(path)
        elif kind == "directory":
            path.mkdir(parents=True, exist_ok=True)
            (path / "controlled-placeholder.txt").write_text(
                f"controlled-phase0-artifact:{artifact['artifact_id']}",
                encoding="utf-8",
            )
            snapshot = snapshot_directory(path)
            files = [entry for entry in snapshot.entries if entry.entry_type == "file"]
            artifact["manifest_sha256"] = snapshot.manifest_sha256
            artifact["expected_file_count"] = len(files)
            artifact["expected_total_file_size"] = sum(entry.size or 0 for entry in files)
        else:
            raise AssertionError(f"Unsupported source artifact kind: {kind!r}")


def _report_root(catalog_path: Path) -> str:
    catalog = _load_json(catalog_path)
    fixtures = _objects(catalog, "fixtures")
    pdf_path = _text(fixtures[0], "pdf_path")
    marker = "/reports/phase0"
    index = pdf_path.replace("\\", "/").find(marker)
    if index < 0:
        raise AssertionError("Fixture render catalog has no project report path")
    return pdf_path.replace("\\", "/")[:index]


def _profile_renderer_path(render_environment: JsonObject) -> str:
    return _text(_profile(render_environment), "executable_path")


def _profile(render_environment: JsonObject) -> JsonObject:
    profiles = _objects(render_environment, "profiles")
    for profile in profiles:
        if profile.get("profile_id") == "wps-writer-12.1.0.28505":
            return profile
    raise AssertionError("Pinned WPS render profile is absent")


def _artifact_hash(source_catalog: JsonObject, artifact_id: str) -> str:
    for artifact in _objects(source_catalog, "artifacts"):
        if artifact.get("artifact_id") == artifact_id:
            return _text(artifact, "sha256")
    raise AssertionError(f"Source artifact is absent: {artifact_id}")


def _objects(document: JsonObject, key: str) -> list[JsonObject]:
    value = document.get(key)
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise AssertionError(f"Expected object array: {key}")
    return cast(list[JsonObject], value)


def _text(document: JsonObject, key: str) -> str:
    value = document.get(key)
    if not isinstance(value, str) or not value:
        raise AssertionError(f"Expected text field: {key}")
    return value


def _load_json(path: Path) -> JsonObject:
    """Read copied historical JSON while accepting the BOM emitted by Windows tools."""
    return decode_json_object(path.read_text(encoding="utf-8-sig"))
