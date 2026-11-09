"""Contract-level checks used by the Phase 0 validation orchestration."""

from pathlib import Path
from typing import cast

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import JsonObject, JsonValue
from research_file_workbench.phase0.contract_checks import (
    object_array,
    object_value,
    string_array,
    string_value,
)
from research_file_workbench.phase0.contracts import load_render_profiles, load_source_catalog
from research_file_workbench.phase0.inventory import build_source_inventory
from research_file_workbench.phase0.models import (
    ContractValueError,
    RenderProfileSpec,
    SourceArtifactSpec,
)

REQUIRED_CONTRACTS = (
    "source-catalog.json",
    "render-environments.json",
    "render-baselines.json",
    "capability-boundary.json",
    "fixture-matrix.json",
    "cache-invalidation.json",
    "minimum-schema.json",
    "acceptance-fixtures.json",
    "docx-fixture-catalog.json",
    "native-docx-fixture-catalog.json",
    "non-docx-scenarios.json",
    "digest-contract.json",
    "s1-handoff-acceptance.json",
)


def validation_report(
    checks: list[JsonObject],
    completion_checks: list[JsonObject],
    completion_blockers: list[JsonObject],
) -> JsonObject:
    """Build the stable Phase 0 validation report envelope."""
    contract_valid = all(check.get("passed") is True for check in checks)
    phase0_complete = (
        contract_valid
        and all(check.get("passed") is True for check in completion_checks)
        and not completion_blockers
    )
    return {
        "report_version": "1.3.0",
        "generated_at": utc_now_iso(),
        "contract_valid": contract_valid,
        "phase0_complete": phase0_complete,
        "completion_blockers": completion_blockers,
        "checks": checks,
        "completion_checks": completion_checks,
    }


def object_array_or_error(document: JsonObject | None, key: str) -> list[JsonObject]:
    """Require an object array from a loaded contract document."""
    if document is None:
        raise ContractValueError(f"Missing document for {key}")
    return object_array(document, key)


def load_source_specs(
    contract_directory: Path,
    documents: dict[str, JsonObject],
    checks: list[JsonObject],
) -> tuple[SourceArtifactSpec, ...]:
    """Load source identities and verify the current author-workspace inventory."""
    if "source-catalog.json" not in documents:
        return ()
    try:
        author_root, specs = load_source_catalog(contract_directory / "source-catalog.json")
        inventory = build_source_inventory(author_root, specs)
    except (OSError, ValueError) as exc:
        checks.append(
            {
                "check_id": "source-catalog-runtime-validation",
                "passed": False,
                "detail": str(exc),
            }
        )
        return ()
    artifacts = inventory.get("artifacts")
    if not isinstance(artifacts, list):
        checks.append(
            {
                "check_id": "source-inventory-runtime-validation",
                "passed": False,
                "detail": "Generated source inventory has no artifacts array",
            }
        )
        return specs
    invalid = [
        item.get("artifact_id")
        for item in artifacts
        if isinstance(item, dict)
        and item.get("required") is True
        and item.get("status") != "available"
    ]
    checks.append(
        {
            "check_id": "registered-source-identities-match",
            "passed": not invalid,
            "detail": invalid,
        }
    )
    return specs


def load_render_profile_specs(
    contract_directory: Path,
    documents: dict[str, JsonObject],
    checks: list[JsonObject],
) -> tuple[RenderProfileSpec, ...]:
    """Load renderer profiles and verify executable hashes and pinned settings."""
    if "render-environments.json" not in documents:
        return ()
    try:
        profiles = load_render_profiles(contract_directory / "render-environments.json")
        for profile in profiles:
            if profile.status == "unavailable":
                if profile.executable_path is not None:
                    raise ContractValueError("Unavailable renderer must not name an executable")
                continue
            if profile.executable_path is None or not profile.executable_path.is_file():
                raise ContractValueError(f"Missing renderer: {profile.profile_id}")
            if profile.executable_sha256 != sha256_file(profile.executable_path):
                raise ContractValueError(f"Renderer hash mismatch: {profile.profile_id}")
            if not profile.file_version:
                raise ContractValueError("Renderer version is required")
            for key in ("revision_display", "field_update_behavior", "hidden_text_behavior"):
                string_value(profile.required_settings, key)
            fonts = object_value(profile.required_settings, "font_inventory")
            string_array(fonts, "installed")
            string_array(fonts, "missing", nonempty=False)
            export = object_value(profile.required_settings, "pdf_export_settings")
            string_value(export, "automation")
            if (
                export.get("open_read_only") is not True
                or export.get("format_code") != 17
                or export.get("page_image_dpi") != 150
            ):
                raise ContractValueError("Unpinned PDF export settings")
    except (OSError, ValueError) as exc:
        checks.append(
            {
                "check_id": "render-profile-runtime-validation",
                "passed": False,
                "detail": str(exc),
            }
        )
        return ()
    return profiles


def evaluate_acceptance_fixture(
    fixture: JsonObject,
    *,
    source_specs: tuple[SourceArtifactSpec, ...],
    render_profiles: tuple[RenderProfileSpec, ...],
    fixture_groups: list[JsonObject],
) -> JsonObject:
    """Evaluate one of the fixed, machine-readable Phase 0 acceptance fixtures."""
    fixture_id = fixture.get("fixture_id")
    if not isinstance(fixture_id, str):
        return {
            "check_id": "acceptance-fixture:missing-id",
            "passed": False,
            "detail": fixture,
        }
    artifacts = {artifact.artifact_id: artifact for artifact in source_specs}
    profiles = {profile.profile_id: profile for profile in render_profiles}
    passed = False
    detail: JsonValue

    if fixture_id == "source-catalog-all-required-present":
        missing = [
            artifact.artifact_id
            for artifact in source_specs
            if artifact.required and not artifact.path.exists()
        ]
        passed = missing == fixture.get("expected_missing_ids")
        detail = missing
    elif fixture_id == "english-baseline-does-not-use-chinese-pdf":
        mapping = fixture.get("forbidden_mapping")
        mapping_ids = cast(list[str], mapping) if isinstance(mapping, list) else []
        passed = (
            len(mapping_ids) == 2
            and all(item in artifacts for item in mapping_ids)
            and artifacts[mapping_ids[0]].role == "primary_s1_docx_sample"
            and artifacts[mapping_ids[1]].role == "historical_reference_only"
        )
        detail = mapping_ids
    elif fixture_id == "legacy-doc-is-not-s1-docx":
        artifact_id = fixture.get("artifact_id")
        artifact = artifacts.get(artifact_id) if isinstance(artifact_id, str) else None
        passed = (
            artifact is not None
            and artifact.phase == fixture.get("expected_phase")
            and artifact.path.suffix.lower() == ".doc"
        )
        detail = artifact.phase if artifact else "missing artifact"
    elif fixture_id == "pinned-renderer-profile":
        profile_id = fixture.get("profile_id")
        profile = profiles.get(profile_id) if isinstance(profile_id, str) else None
        passed = (
            profile is not None
            and profile.executable_path is not None
            and profile.executable_path.is_file()
            and profile.executable_sha256 == sha256_file(profile.executable_path)
        )
        detail = profile_id
    elif fixture_id == "missing-word-is-explicit":
        profile_id = fixture.get("profile_id")
        profile = profiles.get(profile_id) if isinstance(profile_id, str) else None
        passed = profile is not None and profile.status == fixture.get("expected_status")
        detail = profile.status if profile else "missing profile"
    elif fixture_id == "fixture-groups-reviewed-with-evidence":
        expected_status = fixture.get("expected_annotation_status")
        passed = bool(fixture_groups) and all(
            item.get("annotation_status") == expected_status for item in fixture_groups
        )
        detail = [item.get("annotation_status") for item in fixture_groups]
    else:
        detail = f"No evaluator registered for {fixture_id}"

    return {
        "check_id": f"acceptance-fixture:{fixture_id}",
        "passed": passed,
        "detail": detail,
    }


def phase0_completion_blockers(
    *,
    source_specs: tuple[SourceArtifactSpec, ...],
    render_profiles: tuple[RenderProfileSpec, ...],
    fixture_groups: list[JsonObject],
    render_baselines: list[JsonObject],
) -> list[JsonObject]:
    """Collect completion blockers that represent unresolved external evidence."""
    blockers: list[JsonObject] = []
    if not fixture_groups or any(
        item.get("annotation_status") != "reviewed" for item in fixture_groups
    ):
        blockers.append(
            {
                "blocker_id": "independent-fixture-annotations-not-reviewed",
                "detail": "Every fixture group must be prepared and independently reviewed",
            }
        )
    wps = next(
        (profile for profile in render_profiles if profile.profile_id == "wps-writer-12.1.0.28505"),
        None,
    )
    if (
        wps is None
        or not wps.required_settings
        or any(
            isinstance(value, str) and value.startswith("to_be_")
            for value in (wps.required_settings.values() if wps else ())
        )
    ):
        blockers.append(
            {
                "blocker_id": "render-profile-settings-not-locked",
                "detail": "Font, field, revision, and PDF export settings must be locked",
            }
        )
    if not any(
        baseline.get("source_artifact_id") == "ijam-english-working-docx"
        and baseline.get("status") in {"candidate_with_known_limitations", "verified"}
        for baseline in render_baselines
    ):
        blockers.append(
            {
                "blocker_id": "english-render-baseline-not-registered",
                "detail": "A dedicated English working-manuscript render baseline is required",
            }
        )
    return blockers


def validate_non_docx_scenarios(
    document: JsonObject,
    render_profiles: tuple[RenderProfileSpec, ...],
    fixture_sample_ids: set[str],
) -> list[JsonObject]:
    """Validate the three mandatory non-DOCX failure scenarios."""
    scenarios = object_array_or_error(document, "scenarios")
    scenario_ids = {
        scenario_id
        for scenario in scenarios
        if isinstance((scenario_id := scenario.get("scenario_id")), str)
    }
    required_ids = {"renderer_unavailable", "render_failure", "bypass_attempt"}
    word_profile = next(
        (profile for profile in render_profiles if profile.profile_id == "microsoft-word-local"),
        None,
    )
    return [
        {
            "check_id": "non-docx-scenario-ids-complete",
            "passed": scenario_ids == required_ids,
            "detail": sorted(scenario_ids),
        },
        {
            "check_id": "renderer-unavailable-scenario-backed-by-profile",
            "passed": word_profile is not None and word_profile.status == "unavailable",
            "detail": word_profile.status if word_profile else "missing profile",
        },
        {
            "check_id": "non-docx-scenario-sources-registered",
            "passed": all(
                scenario["source_sample_id"] in fixture_sample_ids for scenario in scenarios
            ),
            "detail": [scenario["source_sample_id"] for scenario in scenarios],
        },
    ]
