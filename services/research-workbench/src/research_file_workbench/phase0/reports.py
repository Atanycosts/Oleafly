from pathlib import Path

from research_file_workbench.common.filesystem import require_owned_output
from research_file_workbench.common.json_io import JsonObject, write_json_object
from research_file_workbench.common.workspace import build_workspace_fingerprint
from research_file_workbench.phase0.contracts import load_render_profiles, load_source_catalog
from research_file_workbench.phase0.environment import build_render_environment_report
from research_file_workbench.phase0.inventory import build_source_inventory
from research_file_workbench.phase0.validation import validate_phase0_contracts


def build_phase0_reports(project_root: Path) -> dict[str, Path]:
    contracts = project_root / "contracts" / "phase0"
    output = project_root / "reports" / "phase0"
    source_root, artifacts = load_source_catalog(contracts / "source-catalog.json")
    render_profiles = load_render_profiles(contracts / "render-environments.json")

    baseline_path = output / "author-workspace-baseline.json"
    reports: dict[str, JsonObject] = {
        "source-inventory.json": build_source_inventory(source_root, artifacts),
        "render-environment.json": build_render_environment_report(render_profiles),
        "contract-validation.json": validate_phase0_contracts(contracts),
    }
    paths: dict[str, Path] = {}
    if baseline_path.is_file():
        paths["author-workspace-baseline.json"] = baseline_path
    else:
        reports["author-workspace-baseline.json"] = build_workspace_fingerprint(source_root)
    for name, report in reports.items():
        path = output / name
        require_owned_output(path, (project_root / "reports",), (source_root,), allow_existing=True)
        write_json_object(path, report)
        paths[name] = path
    return paths
