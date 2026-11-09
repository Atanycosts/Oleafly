"""Fixture generators preserve occupied outputs, author roots and reviewed evidence."""

import importlib.util
import os
import sys
from pathlib import Path

import pytest

from research_file_workbench.common.filesystem import PathBoundaryError, snapshot_directory
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import write_json_object

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools/fixture_building"

# The frozen Phase 0 source catalog declares the author workspace as a Windows absolute path,
# so the generation boundary refuses to run where that path cannot be absolute.
requires_windows_author_workspace = pytest.mark.skipif(
    os.name != "nt",
    reason="frozen source catalog declares the Windows author workspace root",
)


def load_module(name, path):
    specification = importlib.util.spec_from_file_location(name, path)
    assert specification and specification.loader
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


@pytest.fixture
def builder(monkeypatch):
    monkeypatch.syspath_prepend(str(TOOLS))
    return load_module("build_docx_fixtures", TOOLS / "build_docx_fixtures.py")


@pytest.mark.parametrize(
    "relative",
    [
        "tests/fixtures/docx/normal/s1-regions-fields/s1-regions-fields.docx",
        "annotations/s1/s1-pagination-ambiguity/document-annotation.json",
        "annotations/s1/s1-missing-font/page-evidence.json",
        "contracts/phase0/docx-fixture-catalog.json",
    ],
)
@requires_windows_author_workspace
def test_any_occupied_output_refuses_whole_batch_without_changes(builder, tmp_path, relative):
    target = tmp_path / relative
    target.parent.mkdir(parents=True)
    target.write_bytes(b"reviewed-retained-baseline")
    before = snapshot_directory(tmp_path)
    with pytest.raises(FileExistsError):
        builder.build_fixtures(tmp_path)
    assert snapshot_directory(tmp_path) == before
    assert not (tmp_path / "var").exists()


@requires_windows_author_workspace
def test_redirected_output_directory_is_refused_before_generation(builder, tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    protected = tmp_path / "protected"
    protected.mkdir()
    try:
        (project / "annotations").symlink_to(protected, target_is_directory=True)
    except OSError:
        pytest.skip("Directory symlinks are unavailable")
    before = snapshot_directory(tmp_path)
    with pytest.raises(PathBoundaryError, match="Reparse-point"):
        builder.build_fixtures(project)
    assert snapshot_directory(tmp_path) == before


@requires_windows_author_workspace
def test_selected_catalog_author_root_is_read_only(builder, tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    write_json_object(
        project / "contracts/phase0/source-catalog.json",
        {"author_workspace_root": project.resolve().as_posix()},
    )
    before = snapshot_directory(project)
    with pytest.raises(PathBoundaryError, match="read-only"):
        builder.build_fixtures(project)
    assert snapshot_directory(project) == before


def test_builder_cli_requires_explicit_generation_root(builder, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["build_docx_fixtures.py"])
    with pytest.raises(SystemExit) as error:
        builder.main()
    assert error.value.code == 2


@requires_windows_author_workspace
def test_new_generation_keeps_temporary_files_below_root_and_cleans_them(builder, tmp_path):
    project = tmp_path / "generation"
    records = builder.build_fixtures(project)
    assert len(records) == 7
    assert list((project / "var").iterdir()) == []
    assert len(list((project / "annotations/s1").glob("*/document-annotation.json"))) == 7


@requires_windows_author_workspace
def test_deep_generation_root_keeps_staging_shorter_than_final_paths(builder, tmp_path_factory):
    parent = tmp_path_factory.mktemp("deep")
    longest_relative = max(
        (Path("tests/fixtures/docx") / item.relative_path for item in builder.ALL_FIXTURES),
        key=lambda value: len(str(value)),
    )
    root_length = 249 - len(str(longest_relative)) - 1
    project = parent / ("g" * (root_length - len(str(parent)) - 1))
    assert len(str(project / longest_relative)) == 249
    previous_staging = (project / "var/rfw-docx-fixtures-12345678" / longest_relative).with_suffix(
        ".source.docx"
    )
    assert len(str(previous_staging)) >= 260
    records = builder.build_fixtures(project)
    assert len(records) == 7
    for record in records:
        output = project / "tests/fixtures/docx" / record.identity.relative_path
        frozen = ROOT / "tests/fixtures/docx" / record.identity.relative_path
        assert sha256_file(output) == sha256_file(frozen)
    assert list((project / "var").iterdir()) == []


@pytest.mark.skipif(os.name != "nt", reason="Windows path limit is platform-specific")
def test_unsupported_windows_output_length_fails_before_creating_anything(builder, tmp_path):
    project = tmp_path / ("g" * 150)
    before = snapshot_directory(tmp_path)
    with pytest.raises(ValueError, match="choose a shorter generation root"):
        builder.build_fixtures(project)
    assert snapshot_directory(tmp_path) == before


@requires_windows_author_workspace
def test_render_probe_refuses_existing_default_without_touching_it():
    probe = load_module("render_probe", ROOT / "tools/phase0/build_render_behavior_probe.py")
    before = snapshot_directory(probe.OUTPUT_PATH.parent)
    with pytest.raises(FileExistsError):
        probe.build_probe(probe.OUTPUT_PATH)
    assert snapshot_directory(probe.OUTPUT_PATH.parent) == before


@requires_windows_author_workspace
def test_render_probe_creates_new_file_and_refuses_redirected_parent(tmp_path):
    probe = load_module("render_probe", ROOT / "tools/phase0/build_render_behavior_probe.py")
    output = tmp_path / "probe.docx"
    assert probe.build_probe(output) == output
    assert output.read_bytes().startswith(b"PK")
    assert not list(tmp_path.glob(".render-probe-*"))
    linked = tmp_path / "linked"
    try:
        linked.symlink_to(tmp_path, target_is_directory=True)
    except OSError:
        pytest.skip("Directory symlinks are unavailable")
    with pytest.raises(PathBoundaryError, match="Reparse-point"):
        probe.build_probe(linked / "another.docx")
    assert not (tmp_path / "another.docx").exists()
