import os
import stat
import sys
from dataclasses import dataclass
from pathlib import Path

from research_file_workbench.common.hashing import sha256_file, sha256_text

PROTECTION_KIND = "windows_attributes" if os.name == "nt" else "posix_mode"
WINDOWS_PROTECTED_ATTRIBUTE_MASK = sum(
    getattr(stat, name, 0)
    for name in (
        "FILE_ATTRIBUTE_READONLY",
        "FILE_ATTRIBUTE_HIDDEN",
        "FILE_ATTRIBUTE_SYSTEM",
        "FILE_ATTRIBUTE_ARCHIVE",
        "FILE_ATTRIBUTE_COMPRESSED",
        "FILE_ATTRIBUTE_ENCRYPTED",
        "FILE_ATTRIBUTE_OFFLINE",
        "FILE_ATTRIBUTE_NOT_CONTENT_INDEXED",
        "FILE_ATTRIBUTE_SPARSE_FILE",
        "FILE_ATTRIBUTE_REPARSE_POINT",
    )
)


@dataclass(frozen=True)
class FileSnapshot:
    relative_path: str
    entry_type: str
    size: int | None
    sha256: str | None
    protection_value: int


@dataclass(frozen=True)
class DirectorySnapshot:
    root: str
    entries: tuple[FileSnapshot, ...]
    manifest_sha256: str
    protection_kind: str
    root_protection_value: int
    protection_sha256: str


class PathBoundaryError(ValueError):
    """Raised when a path escapes its declared root."""


def is_within(path: Path, root: Path) -> bool:
    resolved_path = path.resolve(strict=False)
    resolved_root = root.resolve(strict=False)
    return resolved_path == resolved_root or resolved_root in resolved_path.parents


def require_within(path: Path, root: Path) -> None:
    if not is_within(path, root):
        raise PathBoundaryError(f"Path {path} is outside declared root {root}")


def is_reparse_point(path: Path) -> bool:
    """Return whether a Windows path is a junction or another reparse point."""
    file_attributes = getattr(path.lstat(), "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return bool(file_attributes & reparse_flag)


def require_no_reparse_points(path: Path) -> None:
    """Reject existing symbolic links or reparse points throughout a path's parent chain."""
    for component in (path.absolute(), *path.absolute().parents):
        if component.is_symlink() or (component.exists() and is_reparse_point(component)):
            raise PathBoundaryError(f"Reparse-point paths are not allowed: {component}")


def require_owned_output(
    output: Path,
    allowed_roots: tuple[Path, ...],
    forbidden_roots: tuple[Path, ...] = (),
    *,
    allow_existing: bool = False,
) -> None:
    """Require an output to stay in application-owned storage."""
    require_no_reparse_points(output)
    if not any(is_within(output, root) for root in allowed_roots):
        raise PathBoundaryError(f"Output {output} is outside application-owned storage")
    if any(is_within(output, root) for root in forbidden_roots):
        raise PathBoundaryError(f"Output {output} is inside a read-only input workspace")
    if output.exists() and not allow_existing:
        raise FileExistsError(f"Output already exists: {output}")


def snapshot_directory(root: Path) -> DirectorySnapshot:
    """Fingerprint content and observable protection attributes without following links.

    The content manifest preserves the frozen directory identity algorithm. Protection
    uses a separate digest; access times and other volatile timestamps are excluded.
    """
    root = root.resolve()
    if not root.is_dir():
        raise NotADirectoryError(root)
    root_protection = _protection_value(root.lstat())

    entries: list[FileSnapshot] = []
    pending = [root]
    while pending:
        current = pending.pop()
        children = sorted(current.iterdir(), key=lambda item: item.name.casefold())
        for child in children:
            relative_path = child.relative_to(root).as_posix()
            protection = _protection_value(child.lstat())
            if child.is_symlink() or is_reparse_point(child):
                entries.append(
                    FileSnapshot(
                        relative_path=relative_path,
                        entry_type="reparse_point",
                        size=None,
                        sha256=None,
                        protection_value=protection,
                    )
                )
            elif child.is_dir():
                require_within(child, root)
                entries.append(
                    FileSnapshot(
                        relative_path=relative_path,
                        entry_type="directory",
                        size=None,
                        sha256=None,
                        protection_value=protection,
                    )
                )
                pending.append(child)
            elif child.is_file():
                metadata = child.stat()
                entries.append(
                    FileSnapshot(
                        relative_path=relative_path,
                        entry_type="file",
                        size=metadata.st_size,
                        sha256=sha256_file(child),
                        protection_value=protection,
                    )
                )
            else:
                entries.append(
                    FileSnapshot(
                        relative_path=relative_path,
                        entry_type="other",
                        size=None,
                        sha256=None,
                        protection_value=protection,
                    )
                )

    ordered = tuple(sorted(entries, key=lambda entry: entry.relative_path.casefold()))
    manifest_lines = [
        f"{entry.entry_type}\t{entry.relative_path}\t{entry.size or ''}\t{entry.sha256 or ''}"
        for entry in ordered
    ]
    protection_lines = [
        f"{PROTECTION_KIND}\t.\t{root_protection}",
        *[
            f"{entry.entry_type}\t{entry.relative_path}\t{entry.protection_value}"
            for entry in ordered
        ],
    ]
    return DirectorySnapshot(
        root=root.resolve().as_posix(),
        entries=ordered,
        manifest_sha256=sha256_text("\n".join(manifest_lines)),
        protection_kind=PROTECTION_KIND,
        root_protection_value=root_protection,
        protection_sha256=sha256_text("\n".join(protection_lines)),
    )


def _protection_value(metadata: os.stat_result) -> int:
    if sys.platform == "win32":
        return int(metadata.st_file_attributes) & WINDOWS_PROTECTED_ATTRIBUTE_MASK
    return stat.S_IMODE(metadata.st_mode)
