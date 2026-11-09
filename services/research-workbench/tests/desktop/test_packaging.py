"""The desktop package bundles only what it uses, and records why it may."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools" / "desktop"
sys.path.insert(0, str(TOOLS))

import package_runtime  # noqa: E402
from pe_dependencies import PeFormatError, dependency_closure, imported_dlls  # noqa: E402
from third_party_licenses import normalize, recorded_license  # noqa: E402

PDFINFO = Path("C:/Users/Administrator/AppData/Local/Programs/MiKTeX/miktex/bin/x64/pdfinfo.exe")


def test_the_vendored_prefix_and_suffix_are_normalised() -> None:
    assert normalize("MiKTeX251200-Poppler.DLL") == "poppler.dll"
    assert recorded_license("MiKTeX251200-poppler.dll") == (
        "GPL-2.0-or-later",
        "https://poppler.freedesktop.org/",
    )
    assert recorded_license("pdfinfo.exe") is not None
    assert recorded_license("python.exe") is not None


def test_an_unrecorded_component_is_reported_rather_than_assumed() -> None:
    """A binary with no recorded licence must not be silently treated as fine."""
    assert recorded_license("totally-unknown-library.dll") is None


def test_a_non_pe_file_is_refused(tmp_path: Path) -> None:
    sample = tmp_path / "not-a-pe.bin"
    sample.write_bytes(b"not an executable")
    with pytest.raises(PeFormatError):
        imported_dlls(sample)


@pytest.mark.skipif(not PDFINFO.is_file(), reason="The pinned Poppler inspector is unavailable")
def test_only_the_dependency_closure_is_bundled() -> None:
    """Bundling every DLL in the tool directory pulled in a whole TeX distribution.

    The directory holding the inspector contains 135 DLLs and about 147 MB of unrelated Qt,
    ICU, Ghostscript and package-manager code. The closure must be a small subset, and every
    member must have recorded licence provenance before it may ship.
    """
    directory = PDFINFO.parent
    every_dll = sorted(path.name.lower() for path in directory.glob("*.dll"))
    closure = dependency_closure(PDFINFO, [directory])
    assert 0 < len(closure) < len(every_dll) / 2, "the closure is not narrowing the bundle"
    unrecorded = sorted(name for name in closure if recorded_license(name) is None)
    assert unrecorded == [], f"closure members without recorded provenance: {unrecorded}"


@pytest.mark.skipif(not PDFINFO.is_file(), reason="The pinned Poppler inspector is unavailable")
def test_the_closure_excludes_components_the_inspector_does_not_load() -> None:
    """Ghostscript and the ICU data tables are in the directory but not in the closure.

    Qt is different: MiKTeX links its own `-ui-qt` shim into `pdfinfo.exe`, so Qt6 really is
    part of the closure even though a page-count inspector needs no GUI. That is a property of
    this particular Poppler build, recorded here so the cost stays visible rather than being
    mistaken for something the closure could have avoided.
    """
    closure = set(dependency_closure(PDFINFO, [PDFINFO.parent]))
    for absent in ("mgsdll64.dll", "icudt78.dll"):
        assert absent not in closure, f"{absent} is not loaded by the inspector"
    assert "qt6core.dll" in closure, (
        "MiKTeX links Qt into the inspector; update this if that changes"
    )


def test_bundled_inspector_uses_explicit_fixture_root_for_deep_var_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A deeply nested package still verifies a PDF retained by the repository."""
    repository = tmp_path / "repository"
    fixture_root = repository / "reports" / "phase0"
    fixture = fixture_root / "fixtures" / "sample" / "sample.pdf"
    fixture.parent.mkdir(parents=True)
    fixture.write_bytes(b"%PDF-1.7\n%%EOF\n")

    output = repository / "var" / "desktop" / "package" / "nested"
    runtime = output / "runtime"
    inspector = runtime / "bin" / "pdfinfo.exe"
    inspector.parent.mkdir(parents=True)
    inspector.write_bytes(b"portable-inspector")

    calls: list[tuple[list[str], Path]] = []

    def record_run(command: list[str], *, cwd: Path, check: bool, capture_output: bool) -> object:
        assert check is True
        assert capture_output is True
        calls.append((command, cwd))
        return object()

    monkeypatch.setattr(package_runtime.subprocess, "run", record_run)
    package_runtime.verify_bundled_inspector(output, runtime, fixture_root)

    assert calls == [([str(inspector), str(fixture)], output)]


def test_http_package_excludes_mcp_adapter_without_its_runtime_dependencies(
    tmp_path: Path,
) -> None:
    """The isolated desktop package contains only the HTTP/browser application surface."""
    source = tmp_path / "source"
    source.mkdir()
    (source / "server.py").write_text("# HTTP application\n", encoding="utf-8")
    (source / "mcp.py").write_text("# host-only adapter\n", encoding="utf-8")
    destination = tmp_path / "destination"

    package_runtime.copy_tree(source, destination)

    assert (destination / "server.py").is_file()
    assert not (destination / "mcp.py").exists()
