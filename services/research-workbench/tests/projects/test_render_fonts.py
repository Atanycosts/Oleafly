import json
from pathlib import Path

import pytest

from research_file_workbench.common.filesystem import PathBoundaryError
from research_file_workbench.common.hashing import sha256_bytes, sha256_text
from research_file_workbench.projects.render_service import (
    RenderConversionError,
    RendererUnavailableError,
    _stage_fonts,
    font_cache_identity,
)


def _write_source_receipt(directory: Path, files: list[dict[str, object]]) -> None:
    (directory / "source.json").write_text(json.dumps({"files": files}), encoding="utf-8")


def _source_entry(
    path: Path,
    *,
    family: str,
    postscript: str,
    version: str,
    weight: int,
    style: str,
    sha256: str | None = None,
) -> dict[str, object]:
    return {
        "name": path.name,
        "sha256": sha256 or sha256_bytes(path.read_bytes()),
        "family": family,
        "postscript": postscript,
        "version": version,
        "weight": weight,
        "style": style,
    }


def test_stages_static_fonts_by_hash_and_preserves_source_metadata(tmp_path: Path) -> None:
    font_root = tmp_path / "font-cache"
    font_root.mkdir()
    regular = font_root / "Controlled-Regular.ttf"
    outline = font_root / "Controlled-Regular.otf"
    regular.write_bytes(b"controlled-ttf-bytes")
    outline.write_bytes(b"controlled-otf-bytes")
    _write_source_receipt(
        font_root,
        [
            _source_entry(
                regular,
                family="Controlled Serif",
                postscript="ControlledSerif-Regular",
                version="Version 1.2.3",
                weight=400,
                style="normal",
            ),
            _source_entry(
                outline,
                family="Controlled Sans",
                postscript="ControlledSans-Regular",
                version="Version 2.0",
                weight=400,
                style="normal",
            ),
        ],
    )
    destination = tmp_path / "private-profile" / "user" / "fonts"

    staged = _stage_fonts((font_root,), destination)

    assert {Path(str(item["path"])).name for item in staged} == {regular.name, outline.name}
    by_name = {Path(str(item["path"])).name: item for item in staged}
    assert by_name[regular.name] == {
        "path": regular.as_posix(),
        "sha256": sha256_bytes(b"controlled-ttf-bytes"),
        "family": "Controlled Serif",
        "postscript": "ControlledSerif-Regular",
        "version": "Version 1.2.3",
        "weight": 400,
        "style": "normal",
    }
    assert by_name[outline.name] == {
        "path": outline.as_posix(),
        "sha256": sha256_bytes(b"controlled-otf-bytes"),
        "family": "Controlled Sans",
        "postscript": "ControlledSans-Regular",
        "version": "Version 2.0",
        "weight": 400,
        "style": "normal",
    }
    regular_copy = destination / f"{sha256_bytes(regular.read_bytes())}.ttf"
    outline_copy = destination / f"{sha256_bytes(outline.read_bytes())}.otf"
    assert regular_copy.read_bytes() == regular.read_bytes()
    assert outline_copy.read_bytes() == outline.read_bytes()
    assert {path.name for path in destination.iterdir()} == {
        regular_copy.name,
        outline_copy.name,
    }


def test_deduplicates_identical_font_bytes_across_roots(tmp_path: Path) -> None:
    first_root = tmp_path / "first-font-cache"
    second_root = tmp_path / "second-font-cache"
    first_root.mkdir()
    second_root.mkdir()
    first = first_root / "First.ttf"
    second = second_root / "Second.ttf"
    shared_bytes = b"same-controlled-font-bytes"
    first.write_bytes(shared_bytes)
    second.write_bytes(shared_bytes)
    destination = tmp_path / "private-profile" / "user" / "fonts"

    staged = _stage_fonts((first_root, second_root), destination)

    assert staged == [
        {
            "path": first.as_posix(),
            "sha256": sha256_bytes(shared_bytes),
        }
    ]
    assert [path.name for path in destination.iterdir()] == [f"{sha256_bytes(shared_bytes)}.ttf"]


def test_font_cache_identity_is_stable_unique_content_hash(tmp_path: Path) -> None:
    assert font_cache_identity(()) == sha256_text("")
    first_root = tmp_path / "first-font-cache"
    second_root = tmp_path / "second-font-cache"
    first_root.mkdir()
    second_root.mkdir()
    font = first_root / "Controlled.ttf"
    font.write_bytes(b"controlled-font-bytes")
    (second_root / "Duplicate.ttf").write_bytes(font.read_bytes())
    _write_source_receipt(
        first_root,
        [
            _source_entry(
                font,
                family="Controlled",
                postscript="Controlled-Regular",
                version="Version 1.0",
                weight=400,
                style="normal",
            )
        ],
    )

    original = font_cache_identity((first_root, second_root))

    assert original == font_cache_identity((first_root, second_root))
    assert original == sha256_text(sha256_bytes(font.read_bytes()))
    _write_source_receipt(
        first_root,
        [
            _source_entry(
                font,
                family="Controlled",
                postscript="Controlled-Regular",
                version="Version 2.0",
                weight=400,
                style="normal",
            )
        ],
    )
    assert font_cache_identity((first_root, second_root)) == original
    added = second_root / "Added.otf"
    added.write_bytes(b"additional-controlled-font-bytes")
    assert font_cache_identity((first_root, second_root)) != original
    added.write_bytes(b"replacement-controlled-font-bytes")
    assert font_cache_identity((first_root, second_root)) != original


def test_rejects_a_font_that_differs_from_its_source_receipt(tmp_path: Path) -> None:
    font_root = tmp_path / "font-cache"
    font_root.mkdir()
    font = font_root / "Corrupt.ttf"
    font.write_bytes(b"controlled-font-bytes")
    _write_source_receipt(
        font_root,
        [
            _source_entry(
                font,
                family="Corrupt",
                postscript="Corrupt-Regular",
                version="Version 1.0",
                weight=400,
                style="normal",
                sha256="0" * 64,
            )
        ],
    )

    with pytest.raises(RenderConversionError, match="differs from its source receipt"):
        _stage_fonts((font_root,), tmp_path / "private-profile" / "user" / "fonts")


def test_missing_font_root_stages_nothing(tmp_path: Path) -> None:
    destination = tmp_path / "private-profile" / "user" / "fonts"

    assert _stage_fonts((tmp_path / "missing-font-cache",), destination) == []
    assert not destination.exists()


def test_relative_font_root_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(RendererUnavailableError, match="absolute"):
        _stage_fonts(
            (Path("relative-font-cache"),),
            tmp_path / "private-profile" / "user" / "fonts",
        )


def test_root_symlink_is_rejected(tmp_path: Path) -> None:
    font_root = tmp_path / "font-cache"
    font_root.mkdir()
    linked_root = tmp_path / "linked-font-cache"
    try:
        linked_root.symlink_to(font_root, target_is_directory=True)
    except OSError:
        pytest.skip("Symlinks are unavailable in this environment")

    with pytest.raises(PathBoundaryError, match="Reparse-point"):
        _stage_fonts(
            (linked_root,),
            tmp_path / "private-profile" / "user" / "fonts",
        )


def test_font_file_symlink_is_rejected(tmp_path: Path) -> None:
    font_root = tmp_path / "font-cache"
    font_root.mkdir()
    outside_font = tmp_path / "outside.ttf"
    outside_font.write_bytes(b"outside-controlled-font-bytes")
    linked_font = font_root / "Linked.ttf"
    try:
        linked_font.symlink_to(outside_font)
    except OSError:
        pytest.skip("Symlinks are unavailable in this environment")

    with pytest.raises(PathBoundaryError, match="Reparse-point"):
        _stage_fonts(
            (font_root,),
            tmp_path / "private-profile" / "user" / "fonts",
        )


def test_source_receipt_symlink_is_rejected(tmp_path: Path) -> None:
    font_root = tmp_path / "font-cache"
    font_root.mkdir()
    (font_root / "Controlled-Regular.ttf").write_bytes(b"controlled-font-bytes")
    outside_receipt = tmp_path / "outside-source.json"
    outside_receipt.write_text(json.dumps({"files": []}), encoding="utf-8")
    linked_receipt = font_root / "source.json"
    try:
        linked_receipt.symlink_to(outside_receipt)
    except OSError:
        pytest.skip("Symlinks are unavailable in this environment")

    with pytest.raises(PathBoundaryError, match="Reparse-point"):
        _stage_fonts(
            (font_root,),
            tmp_path / "private-profile" / "user" / "fonts",
        )
