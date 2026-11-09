"""Resolve the DLL dependencies of a Windows executable by reading PE import tables.

Standard library only: the packaging step must run without extra build dependencies.
"""

from __future__ import annotations

import struct
from pathlib import Path

PE32_MAGIC = 0x10B
PE32_PLUS_MAGIC = 0x20B


class PeFormatError(ValueError):
    """Raised when a file is not a PE image this reader understands."""


def _rva_to_offset(sections: list[tuple[int, int, int, int]], rva: int) -> int | None:
    """Map a relative virtual address to a file offset, or None when it is not mapped."""
    for virtual_address, virtual_size, raw_pointer, raw_size in sections:
        span = max(virtual_size, raw_size)
        if virtual_address <= rva < virtual_address + span:
            return raw_pointer + (rva - virtual_address)
    return None


def imported_dlls(path: Path) -> list[str]:
    """Return the DLL names an executable or library imports, in file order."""
    data = path.read_bytes()
    if data[:2] != b"MZ":
        raise PeFormatError(f"Not a PE image: {path}")
    pe_offset = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe_offset : pe_offset + 4] != b"PE\0\0":
        raise PeFormatError(f"Missing PE signature: {path}")

    section_count = struct.unpack_from("<H", data, pe_offset + 6)[0]
    optional_size = struct.unpack_from("<H", data, pe_offset + 20)[0]
    optional = pe_offset + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    if magic == PE32_MAGIC:
        directory_offset = optional + 96
        directory_count = struct.unpack_from("<I", data, optional + 92)[0]
    elif magic == PE32_PLUS_MAGIC:
        directory_offset = optional + 112
        directory_count = struct.unpack_from("<I", data, optional + 108)[0]
    else:
        raise PeFormatError(f"Unknown optional header magic {magic:#x}: {path}")

    sections = []
    section_table = optional + optional_size
    for index in range(section_count):
        entry = section_table + index * 40
        virtual_size = struct.unpack_from("<I", data, entry + 8)[0]
        virtual_address = struct.unpack_from("<I", data, entry + 12)[0]
        raw_size = struct.unpack_from("<I", data, entry + 16)[0]
        raw_pointer = struct.unpack_from("<I", data, entry + 20)[0]
        sections.append((virtual_address, virtual_size, raw_pointer, raw_size))

    if directory_count < 2:
        return []
    import_rva, import_size = struct.unpack_from("<II", data, directory_offset + 8)
    if import_rva == 0 or import_size == 0:
        return []
    offset = _rva_to_offset(sections, import_rva)
    if offset is None:
        return []

    names: list[str] = []
    while True:
        entry = data[offset : offset + 20]
        if len(entry) < 20 or entry == b"\0" * 20:
            break
        name_rva = struct.unpack_from("<I", entry, 12)[0]
        name_offset = _rva_to_offset(sections, name_rva)
        if name_offset is None:
            break
        end = data.index(b"\0", name_offset)
        names.append(data[name_offset:end].decode("ascii", "replace"))
        offset += 20
    return names


def dependency_closure(executable: Path, search: list[Path]) -> dict[str, Path]:
    """Resolve the transitive DLL closure, ignoring the Windows system libraries."""
    import sys

    resolved: dict[str, Path] = {}
    pending = [executable]
    seen_files: set[Path] = {executable.resolve()}
    while pending:
        current = pending.pop()
        for name in imported_dlls(current):
            lowered = name.lower()
            if lowered in resolved or lowered in sys.stdlib_module_names:
                continue
            if lowered.startswith(("api-ms-", "ext-ms-")):
                continue
            found = None
            for directory in search:
                candidate = directory / name
                if candidate.is_file():
                    found = candidate
                    break
            if found is None:
                continue
            resolved[lowered] = found
            if found.resolve() not in seen_files:
                seen_files.add(found.resolve())
                pending.append(found)
    return resolved
