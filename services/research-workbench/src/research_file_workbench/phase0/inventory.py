from datetime import UTC, datetime
from pathlib import Path

from research_file_workbench.common.clock import utc_now_iso
from research_file_workbench.common.filesystem import is_within, snapshot_directory
from research_file_workbench.common.hashing import sha256_file
from research_file_workbench.common.json_io import JsonObject
from research_file_workbench.phase0.models import SourceArtifactSpec


def build_source_inventory(
    author_workspace_root: Path, artifacts: tuple[SourceArtifactSpec, ...]
) -> JsonObject:
    reports: list[JsonObject] = []
    for artifact in artifacts:
        reports.append(_inspect_artifact(author_workspace_root, artifact))
    return {
        "report_version": "1.0.0",
        "generated_at": utc_now_iso(),
        "author_workspace_root": author_workspace_root.resolve(strict=False).as_posix(),
        "artifacts": reports,
    }


def _inspect_artifact(root: Path, artifact: SourceArtifactSpec) -> JsonObject:
    path = artifact.path
    report: JsonObject = {
        "artifact_id": artifact.artifact_id,
        "role": artifact.role,
        "path": path.as_posix(),
        "kind": artifact.kind,
        "required": artifact.required,
        "phase": artifact.phase,
        "exists": path.exists(),
        "status": "missing",
        "limitations": list(artifact.limitations),
    }
    if not is_within(path, root):
        report["status"] = "outside_author_workspace"
        return report
    if not path.exists():
        return report

    actual_kind = "directory" if path.is_dir() else "file" if path.is_file() else "other"
    report["actual_kind"] = actual_kind
    if actual_kind != artifact.kind:
        report["status"] = "type_mismatch"
        return report

    if artifact.kind == "file":
        stat = path.stat()
        actual_hash = sha256_file(path)
        report["size"] = stat.st_size
        report["last_write_utc"] = datetime.fromtimestamp(stat.st_mtime, UTC).isoformat()
        report["sha256"] = actual_hash
        report["expected_sha256"] = artifact.sha256
        report["status"] = (
            "available"
            if artifact.sha256 is None or actual_hash == artifact.sha256
            else "hash_mismatch"
        )
    else:
        snapshot = snapshot_directory(path)
        file_entries = [entry for entry in snapshot.entries if entry.entry_type == "file"]
        report["entry_count"] = len(snapshot.entries)
        report["file_count"] = len(file_entries)
        report["total_file_size"] = sum(entry.size or 0 for entry in file_entries)
        report["manifest_sha256"] = snapshot.manifest_sha256
        report["expected_manifest_sha256"] = artifact.manifest_sha256
        report["expected_file_count"] = artifact.expected_file_count
        report["expected_total_file_size"] = artifact.expected_total_file_size
        matches = (
            (
                artifact.manifest_sha256 is None
                or snapshot.manifest_sha256 == artifact.manifest_sha256
            )
            and (
                artifact.expected_file_count is None
                or len(file_entries) == artifact.expected_file_count
            )
            and (
                artifact.expected_total_file_size is None
                or sum(entry.size or 0 for entry in file_entries)
                == artifact.expected_total_file_size
            )
        )
        report["status"] = "available" if matches else "hash_mismatch"
    return report
