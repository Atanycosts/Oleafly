"""Keep dependency boundaries and public entry points aligned with actual modules."""

import ast
import importlib
import importlib.metadata
import re
import tomllib
from pathlib import Path

from research_file_workbench.common.json_io import load_json_object
from research_file_workbench.docx.query import (
    CONTINUATION_AVAILABLE,
    CONTINUATION_EXHAUSTED,
    QUERY_VERSION,
)
from research_file_workbench.docx.report import COVERAGE_STATUS
from research_file_workbench.journals import models
from research_file_workbench.projects.render_validation import BUNDLE_VERSION
from research_file_workbench.workbench import mcp, server

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "src/research_file_workbench"


def test_domain_imports_follow_responsibility_boundaries() -> None:
    allowed = {
        "common": {"common"},
        "phase0": {"common", "phase0"},
        "docx": {"common", "docx"},
        "projects": {"common", "docx", "projects"},
        "journals": {"common", "docx", "journals"},
        "workbench": {"common", "docx", "projects", "journals", "workbench"},
    }
    violations = []
    for path in PACKAGE.rglob("*.py"):
        relative = path.relative_to(PACKAGE)
        if relative.parts == ("__init__.py",):
            continue
        package = relative.parts[0]
        if package not in allowed:
            violations.append(f"{path.relative_to(ROOT)} -> unknown top-level package {package}")
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            names = []
            if isinstance(node, ast.ImportFrom):
                assert node.level == 0, f"Use explicit package imports: {path}:{node.lineno}"
                names = [node.module or ""]
            elif isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            for name in names:
                if name.startswith("research_file_workbench."):
                    domain = name.split(".")[1]
                    if domain not in allowed[package]:
                        violations.append(f"{path.relative_to(ROOT)}:{node.lineno} -> {name}")
    assert violations == [], "\n".join(violations)


def test_published_cli_entry_points_resolve() -> None:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    for target in project["project"]["scripts"].values():
        module, function = target.split(":")
        assert callable(getattr(importlib.import_module(module), function))


def _declared_runtime_import_roots() -> dict[str, set[str]]:
    """Map each declared runtime dependency to the top-level modules it provides.

    A dependency that resolves to no module is kept with an empty set rather than dropped, so a
    declaration the environment cannot satisfy stays visible instead of passing as absent.
    """
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    inverse: dict[str, set[str]] = {}
    for module, distributions in importlib.metadata.packages_distributions().items():
        for distribution in distributions:
            inverse.setdefault(re.sub(r"[-_.]+", "-", distribution).lower(), set()).add(module)
    declared: dict[str, set[str]] = {}
    for requirement in project["project"]["dependencies"]:
        name = re.split(r"[<>=!~\[; ]", requirement.strip(), maxsplit=1)[0].strip()
        declared[name] = inverse.get(re.sub(r"[-_.]+", "-", name).lower(), set())
    return declared


def test_every_declared_dependency_resolves_in_this_environment() -> None:
    """A declared dependency the environment cannot provide would drift past the import check."""
    declared = _declared_runtime_import_roots()
    assert declared, "pyproject.toml declares no runtime dependency to verify"
    unresolved = sorted(name for name, roots in declared.items() if not roots)
    assert unresolved == [], (
        f"declared dependencies that resolve to no installed module: {unresolved}"
    )


def test_runtime_imports_are_stdlib_project_or_declared_dependency() -> None:
    """A runtime import is allowed only when pyproject.toml declares what provides it."""
    import sys

    declared: set[str] = set()
    for roots in _declared_runtime_import_roots().values():
        declared |= roots
    for path in PACKAGE.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            elif isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            else:
                continue
            for name in names:
                root = name.split(".")[0]
                assert (
                    root in sys.stdlib_module_names
                    or root == "research_file_workbench"
                    or root in declared
                ), f"Undeclared runtime dependency: {path}:{node.lineno} -> {name}"


def test_active_contract_methods_match_domain_and_http_implementations() -> None:
    world = load_json_object(ROOT / "contracts/journals/world-contract.json")
    assert world["contract_version"] == models.WORLD_SCHEMA_VERSION
    assert world["method_versions"] == {
        "world_schema": models.WORLD_SCHEMA_VERSION,
        "analyzer": models.ANALYZER_VERSION,
        "checker": models.CHECKER_VERSION,
        "http": server.HTTP_CONTRACT_VERSION,
    }
    assert (
        load_json_object(ROOT / "contracts/s1/read-query.json")["contract_version"] == QUERY_VERSION
    )
    assert (
        load_json_object(ROOT / "contracts/s1/render-bundle.json")["contract_version"]
        == BUNDLE_VERSION
    )
    mcp_contract = load_json_object(ROOT / "contracts/s1/mcp-surface.json")
    assert mcp_contract["contract_version"] == mcp.CONTRACT_VERSION
    assert mcp_contract["server_id"] == mcp.SERVER_ID
    assert mcp_contract["entry_point"] == "rfw-workbench-mcp"
    assert mcp_contract["method_versions"] == mcp.METHOD_VERSIONS
    entry_points = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert (
        entry_points["project"]["scripts"]["rfw-workbench-mcp"]
        == "research_file_workbench.workbench.mcp:main"
    )

    javascript = "\n".join(
        path.read_text(encoding="utf-8") for path in server.STATIC_ROOT.rglob("*.js")
    )
    declarations = re.findall(r'\bconst\s+HTTP_CONTRACT_VERSION\s*=\s*"([^"]+)"\s*;', javascript)
    assert declarations == [server.HTTP_CONTRACT_VERSION]


def test_declared_query_axes_and_exit_codes_match_the_query_implementation() -> None:
    """Bind the declared response axes and exit codes to the code that produces them.

    No automated gate reads the axis declarations of this contract: ``phase0 validate`` only
    validates ``contracts/phase0``, and the method check above reads only ``contract_version``.
    Without this binding a declared status value can go missing, or a produced value can stay
    undeclared, while every gate still passes.
    """
    contract = load_json_object(ROOT / "contracts/s1/read-query.json")
    axes = contract["response_axes"]

    assert set(axes["selection_delivery"]["values"]) == {
        CONTINUATION_AVAILABLE,
        CONTINUATION_EXHAUSTED,
    }
    assert set(axes["status"]["values"]) == {"catalog_only", COVERAGE_STATUS}
    assert set(axes["status"]["conditions"]) == set(axes["status"]["values"])
    assert set(contract["exit_codes"]) == {"0", "1", "2"}


def test_packaged_web_assets_cover_every_served_file() -> None:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    patterns = project["tool"]["setuptools"]["package-data"]["research_file_workbench.workbench"]
    journal_package = PACKAGE / "workbench"
    packaged = {
        path for pattern in patterns for path in journal_package.glob(pattern) if path.is_file()
    }
    served = {server.STATIC_ROOT / filename for filename, _ in server.static_files().values()}
    assert served
    assert served == {path for path in server.STATIC_ROOT.rglob("*") if path.is_file()}
    assert served <= packaged
