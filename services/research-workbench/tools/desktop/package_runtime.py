"""Assemble an isolated desktop directory from verified local build dependencies."""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from pe_dependencies import dependency_closure
from third_party_licenses import recorded_license


def copy_tree(source: Path, destination: Path) -> None:
    """Copy runtime files without environments, tests, caches or local site packages."""
    shutil.copytree(
        source,
        destination,
        ignore=shutil.ignore_patterns(
            "__pycache__",
            "*.pyc",
            "site-packages",
            "test",
            "tests",
            "idlelib",
            "tkinter",
            "turtledemo",
            # The packaged shell exposes HTTP/browser only; the MCP adapter stays host-installed
            # with its declared mcp/pydantic dependencies instead of being copied without them.
            "mcp.py",
        ),
    )


def bundle_poppler(pdfinfo: Path, binary_directory: Path) -> list[str]:
    """Copy only what pdfinfo actually loads, refusing to bundle an unrecorded component.

    The neighbouring directory holds a whole TeX distribution: globbing every DLL there pulled
    135 files and 147 MB of unrelated Qt, ICU, Ghostscript and package-manager code into a
    proprietary package. Resolving the PE import closure instead keeps the shipped set to what
    the inspector needs, and every file in that set must have recorded licence provenance.
    """
    copied: list[str] = []
    unresolved: list[str] = []
    for _name, source in sorted(dependency_closure(pdfinfo, [pdfinfo.parent]).items()):
        if recorded_license(source.name) is None:
            unresolved.append(source.name)
            continue
        shutil.copy2(source, binary_directory / source.name)
        copied.append(source.name)
    if unresolved:
        raise ValueError(
            "Bundled binaries without recorded licence provenance: " + ", ".join(unresolved)
        )
    shutil.copy2(pdfinfo, binary_directory / pdfinfo.name)
    copied.append(pdfinfo.name)
    return copied


def write_third_party_notices(output: Path, bundled: list[str]) -> None:
    """Record what was bundled, under which licence, and where its source is obtained."""
    lines = [
        "Third-party components bundled with this application",
        "===================================================",
        "",
        "This application is proprietary. The components below are redistributed inside this",
        "package and remain under their own licences. The corresponding source for each is",
        "obtainable from the location recorded here.",
        "",
    ]
    for name in sorted(bundled):
        entry = recorded_license(name)
        if entry is None:
            raise ValueError(f"Cannot record a notice for an unrecorded component: {name}")
        licence, source = entry
        lines.append(f"- {name}")
        lines.append(f"    licence: {licence}")
        lines.append(f"    source:  {source}")
    lines.append("")
    (output / "THIRD-PARTY-NOTICES.txt").write_text("\n".join(lines), encoding="utf-8")


def verify_bundled_inspector(output: Path, runtime: Path, fixture_root: Path) -> None:
    """Run the bundled inspector against a retained PDF in the explicit fixture root.

    ``output`` may be nested at any depth below ``repository/var``. Deriving the repository
    from that path is therefore unsafe: a second-level package directory would point at
    ``repository/var`` instead of the checkout. The caller owns the repository-to-fixture
    mapping and passes it explicitly so packaging verifies the bytes that belong to this build.
    """
    sample = sorted(fixture_root.glob("*.pdf"))
    fixture = sorted((fixture_root / "fixtures").rglob("*.pdf"))
    candidate = (sample or fixture)[:1]
    if not candidate:
        raise FileNotFoundError("No retained PDF is available to smoke-test the bundled inspector")
    subprocess.run(
        [str(runtime / "bin" / "pdfinfo.exe"), str(candidate[0])],
        cwd=output,
        check=True,
        capture_output=True,
    )


def package_runtime(repository: Path, output: Path, executable: Path, pdfinfo: Path) -> None:
    """Build a new runnable directory; refuse replacing any existing application output."""
    output = output.resolve()
    if not output.is_relative_to(repository / "var"):
        raise ValueError("Desktop output must be below the repository var directory")
    if output.exists():
        raise FileExistsError(output)
    if sys.platform != "win32":
        raise ValueError("This desktop package requires a Windows Python interpreter")
    for required in (executable, pdfinfo):
        if not required.is_file():
            raise FileNotFoundError(required)
    runtime = output / "runtime"
    runtime.mkdir(parents=True)
    interpreter = Path(sys.base_prefix)
    for name in (
        "python.exe",
        f"python{sys.version_info.major}{sys.version_info.minor}.dll",
        "python3.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
        "LICENSE.txt",
    ):
        source = interpreter / name
        if not source.is_file():
            raise FileNotFoundError(source)
        shutil.copy2(source, runtime / name)
    copy_tree(interpreter / "Lib", runtime / "Lib")
    copy_tree(interpreter / "DLLs", runtime / "DLLs")
    copy_tree(
        repository / "src" / "research_file_workbench",
        runtime / "application" / "research_file_workbench",
    )
    # An explicit path file isolates the embedded interpreter from PATH and user installations.
    (runtime / f"python{sys.version_info.major}{sys.version_info.minor}._pth").write_text(
        "Lib\nDLLs\napplication\n",
        encoding="ascii",
    )
    binary_directory = runtime / "bin"
    binary_directory.mkdir()
    bundled = bundle_poppler(pdfinfo, binary_directory)
    bundled += [
        "python.exe",
        f"python{sys.version_info.major}{sys.version_info.minor}.dll",
        "python3.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
    ]
    write_third_party_notices(output, bundled)
    shutil.copy2(executable, output / "research-file-workbench.exe")
    subprocess.run(
        [
            str(runtime / "python.exe"),
            "-c",
            "import sqlite3,ssl,xml.etree.ElementTree; "
            "from research_file_workbench.workbench.server import static_files; "
            "assert len(static_files()) > 3",
        ],
        cwd=output,
        check=True,
    )
    verify_bundled_inspector(output, runtime, repository / "reports" / "phase0")
    manifest = {
        "python_version": sys.version,
        "source_revision": subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=repository,
            text=True,
        ).strip(),
        "bundled_binaries": sorted(bundled),
        "files": {
            path.relative_to(output).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(output.rglob("*"))
            if path.is_file()
        },
    }
    (output / "package-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(output / "research-file-workbench.exe")


def main() -> None:
    """Read explicit build inputs and assemble one portable application directory."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--executable", type=Path, required=True)
    parser.add_argument("--pdfinfo", type=Path, required=True)
    args = parser.parse_args()
    package_runtime(Path(__file__).resolve().parents[2], args.output, args.executable, args.pdfinfo)


if __name__ == "__main__":
    main()
