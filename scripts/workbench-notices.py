"""Collect the licences of the Python runtime shipped in the Workbench bundle."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import re
import sys
import sysconfig
from pathlib import Path

LICENCE_NAMES = ("LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS")


def dependency_names() -> list[str]:
    pending = ["research-file-workbench", "pyinstaller"]
    seen: set[str] = set()
    while pending:
        name = pending.pop(0)
        normalized = name.lower().replace("_", "-")
        if normalized in seen:
            continue
        seen.add(normalized)
        try:
            distribution = importlib.metadata.distribution(name)
        except importlib.metadata.PackageNotFoundError:
            continue
        for requirement in distribution.requires or []:
            if "extra ==" in requirement:
                continue
            match = re.match(r"\s*([A-Za-z0-9_.-]+)", requirement)
            if match:
                pending.append(match.group(1))
    return sorted(seen)


def licence_files(distribution: importlib.metadata.Distribution) -> list[Path]:
    files: list[Path] = []
    for relative in distribution.files or []:
        name = Path(relative).name.upper()
        if name.startswith(LICENCE_NAMES) or "/LICENSES/" in f"/{Path(relative).as_posix().upper()}":
            path = Path(distribution.locate_file(relative))
            if path.is_file():
                files.append(path)
    return sorted(set(files))


def python_licence() -> Path | None:
    base = Path(sys.base_prefix).resolve()
    roots = [Path(sysconfig.get_path("stdlib")).parent.parent, base, *base.parents[:6]]
    for root in roots:
        for name in ("LICENSE.txt", "LICENSE", "LICENSE.rtf", "licenses/LICENSE.txt"):
            candidate = root / name
            if candidate.is_file():
                return candidate
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    sections: list[str] = []
    hashes: set[str] = set()

    python = python_licence()
    if python is not None:
        sections.append(f"Python {sys.version.split()[0]}\n\n{python.read_text(encoding='utf-8', errors='replace')}")

    for name in dependency_names():
        try:
            distribution = importlib.metadata.distribution(name)
        except importlib.metadata.PackageNotFoundError:
            continue
        licence = distribution.metadata.get("License-Expression") or distribution.metadata.get("License") or "declared in package metadata"
        for path in licence_files(distribution):
            text = path.read_text(encoding="utf-8", errors="replace")
            digest = hashlib.sha256(text.encode()).hexdigest()
            if digest in hashes:
                continue
            hashes.add(digest)
            sections.append(f"{distribution.metadata['Name']} {distribution.version}\nLicence: {licence}\n\n{text}")

    args.output.write_text(
        "Research Workbench bundled third-party notices\n\n" + "\n\n---\n\n".join(sections) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
