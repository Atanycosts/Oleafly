import os
import stat
from pathlib import Path

import pytest

from research_file_workbench.common.workspace import (
    build_workspace_fingerprint,
    compare_workspace_fingerprint,
)


def test_compare_workspace_reports_unchanged(tmp_path: Path) -> None:
    (tmp_path / "source.txt").write_text("stable", encoding="utf-8")
    before = build_workspace_fingerprint(tmp_path)
    after = build_workspace_fingerprint(tmp_path)

    comparison = compare_workspace_fingerprint(before, after)

    assert comparison["unchanged"] is True


def test_compare_workspace_reports_change(tmp_path: Path) -> None:
    source = tmp_path / "source.txt"
    source.write_text("before", encoding="utf-8")
    before = build_workspace_fingerprint(tmp_path)
    source.write_text("after", encoding="utf-8")
    after = build_workspace_fingerprint(tmp_path)

    comparison = compare_workspace_fingerprint(before, after)

    assert comparison["unchanged"] is False


def test_compare_workspace_rejects_different_root(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()

    comparison = compare_workspace_fingerprint(
        build_workspace_fingerprint(first), build_workspace_fingerprint(second)
    )

    assert comparison["same_root"] is False
    assert comparison["unchanged"] is False


def test_workspace_detects_readonly_attribute_change_without_changing_content_identity(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.txt"
    source.write_text("stable", encoding="utf-8")
    original_mode = source.stat().st_mode
    before = build_workspace_fingerprint(tmp_path)
    try:
        source.chmod(
            stat.S_IREAD if os.name == "nt" else stat.S_IMODE(original_mode) & ~stat.S_IWUSR
        )
        after = build_workspace_fingerprint(tmp_path)
    finally:
        source.chmod(original_mode)

    comparison = compare_workspace_fingerprint(before, after)
    assert before["manifest_sha256"] == after["manifest_sha256"]
    assert comparison["content_unchanged"] is True
    assert comparison["protection_status"] == "compatible"
    assert comparison["protection_unchanged"] is False
    assert comparison["unchanged"] is False


@pytest.mark.parametrize("mode", ["historical", "missing-digest", "different-platform"])
def test_workspace_requires_compatible_protection_evidence(tmp_path: Path, mode: str) -> None:
    before = build_workspace_fingerprint(tmp_path)
    after = build_workspace_fingerprint(tmp_path)
    if mode == "historical":
        before["report_version"] = "1.0.0"
        del before["protection_sha256"]
    elif mode == "missing-digest":
        before["protection_sha256"] = ""
    else:
        before["protection_kind"] = "unsupported"
    result = compare_workspace_fingerprint(before, after)
    assert result["content_unchanged"] is True
    assert result["protection_status"] == "incompatible"
    assert result["unchanged"] is False


def test_workspace_ignores_access_timestamp(tmp_path: Path) -> None:
    source = tmp_path / "source.txt"
    source.write_text("stable", encoding="utf-8")
    before = build_workspace_fingerprint(tmp_path)
    metadata = source.stat()
    os.utime(source, ns=(metadata.st_atime_ns + 1_000_000_000, metadata.st_mtime_ns))
    after = build_workspace_fingerprint(tmp_path)
    assert compare_workspace_fingerprint(before, after)["unchanged"] is True


@pytest.mark.skipif(os.name != "nt", reason="Windows observable file attributes")
@pytest.mark.parametrize("attribute_name", ["FILE_ATTRIBUTE_HIDDEN", "FILE_ATTRIBUTE_SYSTEM"])
def test_workspace_detects_windows_hidden_and_system_changes(
    tmp_path: Path, attribute_name: str
) -> None:
    import ctypes
    from ctypes import wintypes

    source = tmp_path / "source.txt"
    source.write_text("stable", encoding="utf-8")
    original_attributes = source.stat().st_file_attributes
    attribute = getattr(stat, attribute_name)
    set_attributes = ctypes.WinDLL("kernel32", use_last_error=True).SetFileAttributesW
    set_attributes.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
    set_attributes.restype = wintypes.BOOL
    before = build_workspace_fingerprint(tmp_path)
    try:
        assert set_attributes(str(source), original_attributes | attribute)
        after = build_workspace_fingerprint(tmp_path)
    finally:
        assert set_attributes(str(source), original_attributes)
    comparison = compare_workspace_fingerprint(before, after)
    assert comparison["content_unchanged"] is True
    assert comparison["protection_unchanged"] is False
    assert comparison["unchanged"] is False
