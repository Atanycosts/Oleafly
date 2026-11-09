from pathlib import Path

import pytest

from research_file_workbench.common.filesystem import (
    PathBoundaryError,
    require_no_reparse_points,
    require_owned_output,
    require_within,
    snapshot_directory,
)
from research_file_workbench.common.hashing import sha256_text


def test_require_within_rejects_path_outside_root(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")

    with pytest.raises(PathBoundaryError):
        require_within(outside, root)


def test_snapshot_directory_detects_content_change(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    source = root / "source.txt"
    source.write_text("before", encoding="utf-8")
    before = snapshot_directory(root)

    source.write_text("after", encoding="utf-8")
    after = snapshot_directory(root)

    assert before.manifest_sha256 != after.manifest_sha256


def test_snapshot_directory_does_not_follow_symlink(tmp_path: Path) -> None:
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("secret", encoding="utf-8")
    link = root / "link.txt"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("Symlinks are unavailable in this environment")

    snapshot = snapshot_directory(root)

    assert snapshot.entries[0].entry_type == "reparse_point"
    assert snapshot.entries[0].sha256 is None


def test_require_owned_output_rejects_author_workspace(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    reports = project_root / "reports"
    reports.mkdir(parents=True)
    author_root = tmp_path / "author"
    author_root.mkdir()

    with pytest.raises(PathBoundaryError):
        require_owned_output(author_root / "manuscript.docx", (reports,), (author_root,))


def test_require_owned_output_rejects_existing_file(tmp_path: Path) -> None:
    reports = tmp_path / "reports"
    reports.mkdir()
    output = reports / "fingerprint.json"
    output.write_text("existing", encoding="utf-8")

    with pytest.raises(FileExistsError):
        require_owned_output(output, (reports,))


def test_reparse_guard_rejects_link_in_parent_chain(tmp_path: Path) -> None:
    directory = tmp_path / "directory"
    directory.mkdir()
    link = tmp_path / "linked-directory"
    try:
        link.symlink_to(directory, target_is_directory=True)
    except OSError:
        pytest.skip("Symlinks are unavailable in this environment")

    with pytest.raises(PathBoundaryError, match="Reparse-point"):
        require_no_reparse_points(link / "not-yet-created" / "response.json")
    require_no_reparse_points(directory / "not-yet-created" / "response.json")


def test_content_manifest_preserves_frozen_algorithm(tmp_path: Path) -> None:
    source = tmp_path / "source.txt"
    source.write_text("fixture", encoding="utf-8")
    snapshot = snapshot_directory(tmp_path)
    expected = f"file\tsource.txt\t7\t{sha256_text('fixture')}"
    assert snapshot.manifest_sha256 == sha256_text(expected)
    assert snapshot.protection_kind in {"windows_attributes", "posix_mode"}
    assert len(snapshot.protection_sha256) == 64
