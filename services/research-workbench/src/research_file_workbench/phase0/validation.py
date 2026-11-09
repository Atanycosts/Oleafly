"""Orchestrate Phase 0 contract, fixture, and baseline validation."""

from pathlib import Path

from research_file_workbench.common.json_io import JsonObject, load_json_object
from research_file_workbench.phase0.contract_checks import (
    object_array,
    string_value,
    validate_contract_content,
)
from research_file_workbench.phase0.validation_baselines import (
    validate_render_baselines as _validate_render_baselines,
)
from research_file_workbench.phase0.validation_contracts import (
    REQUIRED_CONTRACTS as _REQUIRED_CONTRACTS,
)
from research_file_workbench.phase0.validation_contracts import (
    evaluate_acceptance_fixture as _evaluate_acceptance_fixture,
)
from research_file_workbench.phase0.validation_contracts import (
    load_render_profile_specs as _load_render_profile_specs,
)
from research_file_workbench.phase0.validation_contracts import (
    load_source_specs as _load_source_specs,
)
from research_file_workbench.phase0.validation_contracts import (
    object_array_or_error as _object_array,
)
from research_file_workbench.phase0.validation_contracts import (
    phase0_completion_blockers as _phase0_completion_blockers,
)
from research_file_workbench.phase0.validation_contracts import (
    validate_non_docx_scenarios as _validate_non_docx_scenarios,
)
from research_file_workbench.phase0.validation_contracts import (
    validation_report as _validation_report,
)
from research_file_workbench.phase0.validation_fixtures import (
    validate_fixture_contracts as _validate_fixture_contracts,
)


def validate_phase0_contracts(contract_directory: Path) -> JsonObject:
    """Validate Phase 0 contracts and return the stable machine-readable report."""
    checks: list[JsonObject] = []
    documents: dict[str, JsonObject] = {}
    for name in _REQUIRED_CONTRACTS:
        path = contract_directory / name
        if not path.is_file():
            checks.append(
                {
                    "check_id": f"contract-present:{name}",
                    "passed": False,
                    "detail": path.as_posix(),
                }
            )
            continue
        try:
            documents[name] = load_json_object(path)
            validate_contract_content(name, documents[name])
        except (OSError, ValueError) as exc:
            checks.append(
                {
                    "check_id": f"contract-content:{name}",
                    "passed": False,
                    "detail": str(exc),
                }
            )
        else:
            checks.append(
                {
                    "check_id": f"contract-content:{name}",
                    "passed": True,
                    "detail": path.as_posix(),
                }
            )

    if any(check["passed"] is False for check in checks):
        return _validation_report(checks, [], [{"blocker_id": "invalid-contract-content"}])

    source_specs = _load_source_specs(contract_directory, documents, checks)
    render_profiles = _load_render_profile_specs(contract_directory, documents, checks)
    fixture_groups = _object_array(documents.get("fixture-matrix.json"), "fixture_groups")
    acceptance_fixtures = _object_array(documents.get("acceptance-fixtures.json"), "fixtures")
    for fixture in acceptance_fixtures:
        checks.append(
            _evaluate_acceptance_fixture(
                fixture,
                source_specs=source_specs,
                render_profiles=render_profiles,
                fixture_groups=fixture_groups,
            )
        )

    render_baselines = _object_array(documents.get("render-baselines.json"), "baselines")
    checks.append(
        _validate_render_baselines(
            render_baselines,
            source_specs,
            render_profiles,
            project_root=contract_directory.parents[1],
        )
    )
    try:
        fixture_checks, fixture_completion_checks, fixture_blockers = _validate_fixture_contracts(
            contract_directory,
            documents,
            fixture_groups,
            load_json=load_json_object,
        )
    except (OSError, ValueError) as exc:
        fixture_checks = [
            {
                "check_id": "fixture-catalog-sources-and-annotations-valid",
                "passed": False,
                "detail": str(exc),
            }
        ]
        fixture_completion_checks = []
        fixture_blockers = [{"blocker_id": "fixture-contract-errors", "detail": str(exc)}]
    checks.extend(fixture_checks)
    checks.extend(
        _validate_non_docx_scenarios(
            documents["non-docx-scenarios.json"],
            render_profiles,
            {
                string_value(item, "sample_id")
                for name in ("docx-fixture-catalog.json", "native-docx-fixture-catalog.json")
                for item in object_array(documents[name], "fixtures")
            },
        )
    )
    completion_blockers = _phase0_completion_blockers(
        source_specs=source_specs,
        render_profiles=render_profiles,
        fixture_groups=fixture_groups,
        render_baselines=render_baselines,
    )
    completion_blockers.extend(fixture_blockers)
    return _validation_report(checks, fixture_completion_checks, completion_blockers)
