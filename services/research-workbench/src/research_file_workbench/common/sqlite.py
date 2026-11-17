"""Shared SQLite file URI handling."""

from pathlib import Path, PureWindowsPath
from typing import Literal


def sqlite_file_uri(path: Path | PureWindowsPath, mode: Literal["ro", "rw"]) -> str:
    """Serialize an existing database path as an unambiguous SQLite file URI."""
    resolved = path.resolve() if isinstance(path, Path) else path
    if isinstance(resolved, PureWindowsPath):
        value = str(resolved)
        verbatim = "\\\\?\\"
        extended_unc = f"{verbatim}UNC\\"
        if value.upper().startswith(extended_unc):
            resolved = PureWindowsPath(f"\\\\{value[len(extended_unc) :]}")
        elif value.startswith(verbatim):
            resolved = PureWindowsPath(value[len(verbatim) :])
    return f"{resolved.as_uri()}?mode={mode}"
