"""Validation of registered Phase 0 render baselines."""

from pathlib import Path

from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.phase0.evidence_checks import validate_pdf_pages
from research_file_workbench.phase0.models import RenderProfileSpec, SourceArtifactSpec


def validate_render_baselines(
    render_baselines: list[JsonObject],
    source_specs: tuple[SourceArtifactSpec, ...],
    render_profiles: tuple[RenderProfileSpec, ...],
    *,
    project_root: Path,
) -> JsonObject:
    """Check baseline identities, hashes, page directories, and PDF evidence."""
    sources = {source.artifact_id: source for source in source_specs}
    profile_ids = {profile.profile_id for profile in render_profiles}
    failures: list[str] = []
    for baseline in render_baselines:
        baseline_id = baseline.get("baseline_id")
        if not isinstance(baseline_id, str):
            failures.append("missing-baseline-id")
            continue
        source_id = baseline.get("source_artifact_id")
        profile_id = baseline.get("render_profile_id")
        if not isinstance(source_id, str) or source_id not in sources:
            failures.append(f"{baseline_id}:unknown-source")
        elif baseline.get("source_sha256") != sources[source_id].sha256:
            failures.append(f"{baseline_id}:source-hash-mismatch")
        if profile_id not in profile_ids:
            failures.append(f"{baseline_id}:unknown-render-profile")
        try:
            validate_pdf_pages(
                baseline,
                project_root=project_root,
                require_report_root=False,
                pdf_key="pdf_path",
                directory_key="page_image_directory",
            )
        except (OSError, ValueError) as exc:
            failures.append(f"{baseline_id}:{exc}")
    return {
        "check_id": "registered-render-baselines-valid",
        "passed": bool(render_baselines) and not failures,
        "detail": failures,
    }
