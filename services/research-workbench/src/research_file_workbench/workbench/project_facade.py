"""Project metadata projections used by the local workbench service.

These functions keep storage reads and presentation shaping separate from the
HTTP and manuscript operation methods.  Callbacks are supplied by the service
so tests and callers retain the existing validation and lookup boundaries.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from research_file_workbench.common.filesystem import require_no_reparse_points
from research_file_workbench.common.json_io import JsonObject, load_json_object
from research_file_workbench.journals.store import WorldStore
from research_file_workbench.projects.service import open_project
from research_file_workbench.workbench.manuscripts import manuscript_workspace

ProjectLookup = Callable[[str], JsonObject]
CheckLookup = Callable[[str], JsonObject]
RootLookup = Callable[[str], Path]


def project_details(
    *,
    project_id: str,
    project_root: RootLookup,
    store: WorldStore,
    check_record: CheckLookup,
) -> JsonObject:
    """Return a managed project identity with binding and latest check."""
    path = project_root(project_id)
    project_store = open_project(path)
    baseline = project_store.get_baseline()
    display_path = path / "display.json"
    require_no_reparse_points(display_path)
    display = load_json_object(display_path)
    if set(display) != {"name", "filename"}:
        raise ValueError("论文显示元数据字段不完整。")
    name = _display_name(display.get("name"))
    filename_value = display.get("filename")
    if not isinstance(filename_value, str):
        raise ValueError("论文显示元数据文件名无效。")
    filename = _name(filename_value)
    if Path(filename).suffix.lower() != ".docx":
        raise ValueError("论文显示元数据文件名无效。")
    binding = store.get_binding(project_id)
    checks = store.list_checks(project_id=project_id)
    latest: JsonObject | None = None
    if checks:
        # The store returns commit order; a clock adjustment must not hide a later check.
        latest = check_record(_text(checks[-1], "check_id"))
    return {
        "project_id": project_id,
        "name": name,
        "baseline_id": baseline["baseline_id"],
        "binding": binding,
        "latest_check": latest,
    }


def discover_state(*, root: Path, store: WorldStore, project_lookup: ProjectLookup) -> JsonObject:
    """Return discovery metadata without recording a content read or review."""
    store.validate_library()
    projects = root / "projects"
    require_no_reparse_points(projects)
    records: list[JsonObject] = []
    if projects.exists():
        for path in sorted(projects.iterdir()):
            require_no_reparse_points(path)
            if not path.is_dir():
                raise ValueError("论文存储目录包含未知文件，请检查应用数据。")
            records.append(project_lookup(path.name))
    return {
        "worlds": store.list_worlds(),
        "projects": records,
        "capabilities": {
            "scope": "page_geometry",
            "manuscript_editing": False,
            "guide_pdf_analysis": True,
            "guide_pdf_fragments": True,
            "formal_full_journal_acceptance": False,
        },
    }


def manuscript_details(
    *,
    project_id: str,
    baseline_id: str | None,
    project_lookup: ProjectLookup,
    project_root: RootLookup,
) -> JsonObject:
    """Expose selected manuscript objects and page evidence."""
    project = project_lookup(project_id)
    workspace = manuscript_workspace(project_root(project_id), baseline_id)
    return {"project": project, **workspace}


def history_details(
    *,
    project_id: str,
    project_lookup: ProjectLookup,
    check_record: CheckLookup,
    store: WorldStore,
    project_root: RootLookup,
) -> JsonObject:
    """Present checks, bindings, and reads in storage commit order."""
    project_lookup(project_id)
    return {
        "project_id": project_id,
        "checks": [
            check_record(_text(record, "check_id"))
            for record in store.list_checks(project_id=project_id)
        ],
        "bindings": store.list_bindings(project_id),
        "reads": open_project(project_root(project_id)).list_reads(),
    }


def diff_worlds(store: WorldStore, from_version: str, to_version: str) -> JsonObject:
    """Compare effective rule content while retaining context differences explicitly."""
    before = store.get_world(from_version)
    after = store.get_world(to_version)
    left = {_text(rule, "property"): rule for rule in _records(before, "rules")}
    right = {_text(rule, "property"): rule for rule in _records(after, "rules")}
    changes = []
    for property_name in sorted(left.keys() | right.keys()):
        prior, current = left.get(property_name), right.get(property_name)
        fields = ("expected", "basis_status", "scope", "unit", "evidence", "resolution")
        changed = (
            prior is None
            or current is None
            or any(prior.get(field) != current.get(field) for field in fields)
        )
        changes.append(
            {
                "property": property_name,
                "before": prior,
                "after": current,
                "status": "added"
                if prior is None
                else "removed"
                if current is None
                else "changed"
                if changed
                else "unchanged",
            }
        )
    return {
        "from_version": from_version,
        "to_version": to_version,
        "scope_changed": before["scope"] != after["scope"],
        "journal_changed": before["journal_id"] != after["journal_id"],
        "changes": changes,
    }


def _name(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or Path(value).name != value
        or any(c in value for c in ("/", "\\", ":", "\0"))
    ):
        raise ValueError("请提供文件名，不要提供文件路径。")
    return value


def _display_name(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("请填写论文名称。")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise ValueError("论文名称不能包含控制字符。")
    return value.strip()


def _text(value: JsonObject, key: str) -> str:
    field = value.get(key)
    if not isinstance(field, str) or not field:
        raise ValueError(f"Missing {key}")
    return field


def _records(value: JsonObject, key: str) -> list[JsonObject]:
    field = value.get(key)
    if not isinstance(field, list) or any(not isinstance(item, dict) for item in field):
        raise ValueError(f"Invalid {key}")
    return field
