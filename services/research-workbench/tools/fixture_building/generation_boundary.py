"""Preflight bounded fixture outputs without overwriting retained author or review inputs."""

from pathlib import Path

from research_file_workbench.common.filesystem import (
    require_no_reparse_points,
    require_owned_output,
)
from research_file_workbench.common.json_io import load_json_object


def author_roots(project_root: Path) -> tuple[Path, ...]:
    """Load declared author roots from the tool checkout and selected generation root."""
    repository_root = Path(__file__).resolve().parents[2]
    roots: set[Path] = set()
    for root in (repository_root, project_root):
        catalog = root / "contracts/phase0/source-catalog.json"
        require_no_reparse_points(catalog)
        if not catalog.exists():
            continue
        author_root = load_json_object(catalog).get("author_workspace_root")
        if not isinstance(author_root, str) or not author_root.strip():
            raise ValueError(f"Source catalog has no declared author workspace: {catalog}")
        path = Path(author_root)
        if not path.is_absolute():
            raise ValueError(f"Author workspace must be absolute in source catalog: {catalog}")
        roots.add(path)
    return tuple(roots)


def preflight_outputs(project_root: Path, outputs: tuple[Path, ...]) -> None:
    """Reject any occupied or redirected batch output before generation creates files."""
    require_no_reparse_points(project_root)
    forbidden = author_roots(project_root)
    require_owned_output(project_root, (project_root,), forbidden, allow_existing=True)
    for output in outputs:
        require_owned_output(output, (project_root,), forbidden)
