from pathlib import Path

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.phase0.models import RenderProfileSpec


def build_render_environment_report(profiles: tuple[RenderProfileSpec, ...]) -> JsonObject:
    results: list[JsonObject] = []
    for profile in profiles:
        results.append(_inspect_profile(profile))
    return {
        "report_version": "1.0.0",
        "generated_at": utc_now_iso(),
        "profiles": results,
    }


def _inspect_profile(profile: RenderProfileSpec) -> JsonObject:
    report: JsonObject = {
        "profile_id": profile.profile_id,
        "renderer": profile.renderer,
        "declared_status": profile.status,
        "executable_path": profile.executable_path.as_posix() if profile.executable_path else None,
        "file_version": profile.file_version,
        "required_settings": profile.required_settings,
        "limitations": list(profile.limitations),
    }
    if profile.executable_path is None:
        report["actual_status"] = "unavailable"
        report["exists"] = False
        return report

    path = Path(profile.executable_path)
    report["exists"] = path.is_file()
    if not path.is_file():
        report["actual_status"] = "missing"
        return report
    actual_hash = sha256_file(path)
    report["actual_sha256"] = actual_hash
    report["expected_sha256"] = profile.executable_sha256
    report["actual_status"] = (
        "available"
        if profile.executable_sha256 is None or actual_hash == profile.executable_sha256
        else "hash_mismatch"
    )
    return report
